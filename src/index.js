'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { transitionIssue, addComment, getIssue, getIssueSummary } = require('./jira');
const { replyToThread, fetchMessage, searchMyMessages, preview } = require('./slack');
const { extractJiraKey, extractAllJiraKeys, extractSlackThread } = require('./utils');
const { fetchPrTitle, fetchPrData, fetchPrCommits, approvePr } = require('./github');

const ALLOWED_BASE_BRANCHES = ['develop', 'releasing_staging', 'main', 'master'];
const NOTIFY_BASE_BRANCHES = ['develop', 'releasing_staging'];

const app = express();

app.use(express.json({
  verify: (_req, _res, buf) => { _req.rawBody = buf; },
}));

// Slack slash commands send application/x-www-form-urlencoded
app.use(express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.status(200).send('OK'));

// ─── Slack Events ─────────────────────────────────────────────────────────────

app.post('/slack/events', async (req, res) => {
  const body = req.body;

  // One-time URL verification handshake when setting up Slack Event Subscriptions
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately — Slack retries if no fast response
  res.sendStatus(200);

  // Skip Slack retries to avoid double-processing
  if (req.headers['x-slack-retry-num']) return;

  if (!verifySlackSignature(req)) {
    console.warn('[Slack] Invalid signature — request ignored');
    return;
  }

  const event = body.event;
  if (!event) return;

  if (event.type === 'message') {
    await handleReviewMessage(event);
  } else if (event.type === 'reaction_added' && event.reaction === 'white_check_mark') {
    // ✅ on my own message → QA Ready flow
    // ✅ on a teammate's message → approve their PR(s)
    if (event.item_user === process.env.MY_SLACK_USER_ID) {
      await handleReactionAdded(event);
    } else {
      await handleApproveReaction(event);
    }
  }
});

// ─── Worklog audit: list Jira tickets mentioned in my channels for a given day ──

function todayInBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/**
 * Searches all messages I posted on `day` (any channel/DM accessible to my user
 * token), extracts Jira keys, groups by channel. Returns
 *   { messagesScanned, results: [{ channel, isPrivate, jiraKeys }] }.
 */
async function auditTicketsByDay(day) {
  const userId = process.env.MY_SLACK_USER_ID;
  const query = `from:<@${userId}> on:${day}`;
  const matches = await searchMyMessages(query);

  const ignoredChannels = new Set(
    (process.env.IGNORED_AUDIT_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const filtered = matches.filter(m => !ignoredChannels.has(m.channel?.id));
  console.log(`[Audit] ${filtered.length} messages from me on ${day} (after filtering ${matches.length - filtered.length} in ignored channels)`);

  // Flat, deduped list of Jira keys across all kept messages, in first-occurrence order.
  const seen = new Set();
  const orderedKeys = [];
  for (const m of filtered) {
    for (const key of extractAllJiraKeys(m.text || '')) {
      if (!seen.has(key)) { seen.add(key); orderedKeys.push(key); }
    }
  }

  // Fetch summaries in parallel; null on failure / missing.
  const summaries = await Promise.all(orderedKeys.map(getIssueSummary));
  const tickets = orderedKeys.map((key, i) => ({ key, summary: summaries[i] }));

  return { messagesScanned: filtered.length, tickets };
}

function formatAuditReport(day, messagesScanned, tickets) {
  const host = (process.env.JIRA_HOST || '').replace(/\/+$/, '');
  const body = tickets.length
    ? tickets.map(t => {
        const link = `<${host}/browse/${t.key}|${t.key}>`;
        return t.summary ? `${link}: ${t.summary}` : link;
      }).join('\n')
    : '_no Jira keys mentioned in any of my messages that day_';
  return `📋 *Jira tickets I mentioned on ${day}*\nMessages scanned: \`${messagesScanned}\`\n${body}`;
}

/**
 * GET /jira/tickets-by-day?date=YYYY-MM-DD
 * Same logic as the slash command — useful for curl debugging.
 */
app.get('/jira/tickets-by-day', async (req, res) => {
  const day = req.query.date || todayInBangkok();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  const { messagesScanned, tickets } = await auditTicketsByDay(day);
  await preview(formatAuditReport(day, messagesScanned, tickets), { tag: false });

  res.json({ date: day, messagesScanned, tickets });
});

// ─── Slack Slash Commands ─────────────────────────────────────────────────────

/**
 * POST /slack/commands — Slack slash command endpoint.
 * Handles `/tickets-by-day [YYYY-MM-DD]`. Acks within Slack's 3-second window
 * with an ephemeral "running" message, then posts the full report to response_url.
 */
app.post('/slack/commands', async (req, res) => {
  if (!verifySlackSignature(req)) {
    console.warn('[Slack cmd] Invalid signature — request ignored');
    return res.status(401).send('invalid signature');
  }

  const { command, text, user_id, response_url } = req.body || {};

  // Only the owner may trigger any slash command. Silently 200 for everyone else
  // (no reply at all — don't reveal that this is a personal bot).
  if (user_id !== process.env.MY_SLACK_USER_ID) {
    console.log(`[Slack cmd] ignoring ${command} from non-owner user ${user_id}`);
    return res.sendStatus(200);
  }

  // Ack immediately — Slack times out after 3s
  res.json({ response_type: 'ephemeral', text: `⏳ Running \`${command}\`...` });

  if (command === '/tickets') {
    runTicketsByDayCommand(text, response_url).catch(err => {
      console.log('[Slack cmd] /tickets failed:', err.message);
    });
    return;
  }

  await postToResponseUrl(response_url, {
    response_type: 'ephemeral',
    text: `❌ Unknown command \`${command}\`.`,
  });
});

async function runTicketsByDayCommand(text, responseUrl) {
  const day = (text || '').trim() || todayInBangkok();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    await postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      text: `❌ Invalid date \`${day}\` — use YYYY-MM-DD.`,
    });
    return;
  }

  const { messagesScanned, tickets } = await auditTicketsByDay(day);
  await postToResponseUrl(responseUrl, {
    response_type: 'ephemeral',
    text: formatAuditReport(day, messagesScanned, tickets),
  });
}

async function postToResponseUrl(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.log('[Slack cmd] response_url post failed:', err.message);
  }
}

// ─── Git Hook Endpoint ────────────────────────────────────────────────────────

app.post('/git/push', async (req, res) => {
  res.sendStatus(200);

  const { jiraKey } = req.body;
  if (!jiraKey) return;

  console.log(`[Git] push detected — transitioning ${jiraKey} → In Progress`);
  await transitionIssue(jiraKey, process.env.ID_IN_PROGRESS);
});

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * New root message in #backend-review-code from me → Jira: In Review
 */
async function handleReviewMessage(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.channel !== process.env.SLACK_REVIEW_CHANNEL) return;

  // Root messages only — ignore thread replies
  if (event.thread_ts && event.thread_ts !== event.ts) return;

  const text = event.text || '';

  // Must contain a GitHub PR link
  // Slack wraps URLs in angle brackets: <https://github.com/...> — strip them before matching
  const cleanText = text.replace(/<([^>]+)>/g, '$1');
  const prUrlMatch = cleanText.match(/https:\/\/github\.com\/[^|\s]+\/pull\/\d+/);
  if (!prUrlMatch) return;

  // Try extracting Jira key from message text first, fallback to PR title
  let jiraKey = extractJiraKey(text);

  if (!jiraKey) {
    const prTitle = await fetchPrTitle(prUrlMatch[0]);
    if (prTitle) {
      jiraKey = extractJiraKey(prTitle);
      console.log(`[GitHub] PR title: "${prTitle}"`);
    }
  }

  if (!jiraKey) {
    console.log('[Slack] message event: no Jira key found in message or PR title');
    return;
  }

  console.log(`[Slack] review message detected — transitioning ${jiraKey} → In Review`);
  await transitionIssue(jiraKey, process.env.ID_IN_REVIEW);
}

/**
 * ✅ reaction on my message in #backend-review-code → Jira: QA Ready (+ comment + Slack thread for develop/releasing_staging)
 */
async function handleReactionAdded(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.reaction !== 'white_check_mark') return;
  if (event.item.type !== 'message') return;
  if (event.item.channel !== process.env.SLACK_REVIEW_CHANNEL) return;

  // Fetch the original message to extract Jira key and PR URL
  const message = await fetchMessage(event.item.channel, event.item.ts);
  if (!message) {
    console.warn('[Slack] reaction_added: could not fetch original message');
    return;
  }

  const text = message.text || '';
  const cleanText = text.replace(/<([^>]+)>/g, '$1');
  const prUrlMatch = cleanText.match(/https:\/\/github\.com\/[^|\s]+\/pull\/\d+/);
  if (!prUrlMatch) {
    console.log('[Slack] reaction_added: no PR URL in message');
    return;
  }

  const prUrl = prUrlMatch[0];
  const prData = await fetchPrData(prUrl);
  if (!prData) {
    console.log('[Slack] reaction_added: could not fetch PR data');
    return;
  }

  const baseBranch = prData.baseBranch;
  if (!ALLOWED_BASE_BRANCHES.includes(baseBranch)) {
    console.log(`[Slack] reaction_added: skipping — base branch "${baseBranch}" not in ${ALLOWED_BASE_BRANCHES.join(', ')}`);
    return;
  }

  // For releasing_staging: PR contains commits from many people. Filter to mine
  // (either author OR committer — cherry-picks count too), dedupe by Jira key,
  // and process each ticket.
  let jiraKeys;
  if (baseBranch === 'releasing_staging') {
    const commits = await fetchPrCommits(prUrl);
    const myUsername = process.env.MY_GITHUB_USERNAME;
    const myCommits = commits.filter(
      c => c.authorLogin === myUsername || c.committerLogin === myUsername
    );
    jiraKeys = [...new Set(myCommits.map(c => extractJiraKey(c.message)).filter(Boolean))];

    if (jiraKeys.length === 0) {
      console.log(`[Slack] reaction_added: no Jira keys found in my commits for ${prUrl}`);
      return;
    }
    console.log(`[Slack] releasing_staging PR — processing ${jiraKeys.length} ticket(s): ${jiraKeys.join(', ')}`);
  } else {
    let jiraKey = extractJiraKey(text);
    if (!jiraKey) {
      jiraKey = extractJiraKey(prData.title);
      console.log(`[GitHub] PR title: "${prData.title}"`);
    }
    if (!jiraKey) {
      console.log('[Slack] reaction_added: no Jira key found in message or PR title');
      return;
    }
    jiraKeys = [jiraKey];
  }

  for (const jiraKey of jiraKeys) {
    await processQaReadyTicket(jiraKey, baseBranch);
  }
}

async function processQaReadyTicket(jiraKey, baseBranch) {
  console.log(`[Slack] ✅ transitioning ${jiraKey} → QA Ready (base: ${baseBranch})`);

  const transitioned = await transitionIssue(jiraKey, process.env.ID_QA_READY);
  if (!transitioned) return;

  // For main/master we only transition — no comment, no Slack reply
  if (!NOTIFY_BASE_BRANCHES.includes(baseBranch)) return;

  const DELAY_MS = Number(process.env.QA_NOTIFY_DELAY_MINUTES ?? 15) * 60 * 1000;
  console.log(`[Slack] ⏳ waiting ${process.env.QA_NOTIFY_DELAY_MINUTES ?? 15} minutes before notifying QA for ${jiraKey}...`);
  await new Promise(resolve => setTimeout(resolve, DELAY_MS));

  const env = baseBranch === 'releasing_staging' ? 'STAGING' : 'DEV';

  await addComment(jiraKey, `Ready for QA testing on ${env}`);

  try {
    const issue = await getIssue(jiraKey);
    const isBug = issue.fields.issuetype.name === 'Bug';

    if (isBug) {
      const thread = extractSlackThread(issue.fields.description);
      if (thread) {
        await replyToThread(
          thread.channel,
          thread.ts,
          `Dạ card này test được ở ${env} rồi ạ`
        );
      } else {
        console.log(`[Slack] Bug ${jiraKey} has no Slack thread link in Jira description`);
      }
    }
  } catch (err) {
    console.log(`[Slack] processQaReadyTicket post-transition error (${jiraKey}):`, err.message);
  }
}

/**
 * ✅ reaction on a teammate's message in #backend-review-code → approve every
 * GitHub PR linked in that message. The dispatch in /slack/events already routes
 * here only when item_user is not me.
 */
async function handleApproveReaction(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.item.type !== 'message') return;
  if (event.item.channel !== process.env.SLACK_REVIEW_CHANNEL) return;

  const message = await fetchMessage(event.item.channel, event.item.ts);
  if (!message) {
    console.warn('[Slack] ✅ on teammate — could not fetch original message');
    return;
  }

  const cleanText = (message.text || '').replace(/<([^>]+)>/g, '$1');
  const prUrls = [...new Set(cleanText.match(/https:\/\/github\.com\/[^|\s]+\/pull\/\d+/g) || [])];
  if (prUrls.length === 0) return;

  console.log(`[Slack] ✅ on teammate message — approving ${prUrls.length} PR(s)`);

  for (const url of prUrls) {
    const ok = await approvePr(url);
    await preview(
      `${ok ? '✅' : '⚠️'} *PR ${ok ? 'approved' : 'approve failed'}*\n<${url}|${url}>`,
      { tag: false }
    );
  }
}

// ─── Slack Signature Verification ────────────────────────────────────────────

function verifySlackSignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return true; // skip in dev if not configured

  const timestamp = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!timestamp || !sig) return false;

  // Reject replayed requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const base = `v0:${timestamp}:${req.rawBody}`;
  const digest = `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;

  return sig.length === digest.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
}

module.exports = app;
