'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { transitionIssue, addComment, getIssue, getIssueSummary } = require('./jira');
const { replyToThread, fetchMessage, searchMyMessages, preview, buildThreadLink, respondEphemeral, reactToMessage } = require('./slack');
const { extractJiraKey, extractAllJiraKeys, extractSlackThread } = require('./utils');
const { fetchPrTitle, fetchPrData, fetchPrCommits, approvePr } = require('./github');
const { runPrReview, reviewSkipReason, cancelReview } = require('./review');

const ALLOWED_BASE_BRANCHES = ['develop', 'releasing_staging', 'main', 'master'];
const NOTIFY_BASE_BRANCHES = ['develop', 'releasing_staging'];
const REVIEW_REACTION = 'eyes';

const REVIEW_AGAIN_ACTION = 'review_pr_again';
const REVIEW_CANCEL_ACTION = 'review_pr_cancel';
// How many times teammates (anyone but me) may re-run a review from the button,
// per PR. I'm unlimited — the cap only stops the button being hammered.
const MAX_TEAMMATE_REVIEWS = 2;

// PR URLs with a Claude review currently running — a second 👀 on the same PR is
// ignored until the first run finishes (reviews take minutes and post to GitHub).
const reviewsInFlight = new Set();

// PR URL → number of "Review again" runs started by teammates. In memory only,
// so a restart clears the budget; the cap is a courtesy guard, not a quota.
const teammateReviewRuns = new Map();

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
  } else if (event.type === 'reaction_added' && event.reaction === REVIEW_REACTION) {
    // 👀 on any message → run Claude Code's review-pr skill on the linked PR(s)
    await handleReviewRequestReaction(event);
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
  // Delay the whole QA notification — transition, comment, and Slack reply all
  // happen after QA_NOTIFY_DELAY_MINUTES, so QA isn't pinged until the PR is
  // demonstrably stable for a few minutes.
  const DELAY_MS = Number(process.env.QA_NOTIFY_DELAY_MINUTES ?? 15) * 60 * 1000;
  console.log(`[Slack] ⏳ waiting ${process.env.QA_NOTIFY_DELAY_MINUTES ?? 15} minutes before QA Ready transition for ${jiraKey}...`);
  await new Promise(resolve => setTimeout(resolve, DELAY_MS));

  console.log(`[Slack] ✅ transitioning ${jiraKey} → QA Ready (base: ${baseBranch})`);

  const transitioned = await transitionIssue(jiraKey, process.env.ID_QA_READY);
  if (!transitioned) return;

  // For main/master we only transition — no comment, no Slack reply
  if (!NOTIFY_BASE_BRANCHES.includes(baseBranch)) return;

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

  console.log(`[Slack] ✅ on teammate message — item_user=${event.item_user}`);

  const ignoredTeammates = new Set(
    (process.env.IGNORED_TEAMMATE || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  if (ignoredTeammates.has(event.item_user)) {
    console.log(`[Slack] ✅ skipping approve flow for ignored item_user ${event.item_user}`);
    return;
  }

  const message = await fetchMessage(event.item.channel, event.item.ts);
  if (!message) {
    console.warn('[Slack] ✅ on teammate — could not fetch original message');
    return;
  }

  // conversations.history only returns top-level messages. If the reacted item's
  // ts doesn't match the returned message's ts, it was a thread reply — skip so
  // we don't accidentally approve the PR linked in the root message.
  if (message.ts !== event.item.ts) {
    console.log(`[Slack] ✅ on thread reply — skipping approve flow (reacted ts=${event.item.ts}, root ts=${message.ts})`);
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

/**
 * 👀 reaction on a message in #backend-review-code → run Claude Code's `review-pr`
 * skill against every GitHub PR linked in that message.
 *
 * Per PR: reply in the message's thread that the review started, run
 * `claude -p "/review-pr <n>"` in the local clone (it posts 🔴 High + 🟡 Medium
 * findings to the PR itself), then reply again with the comment URL and ping me in
 * SLACK_PREVIEW_CHANNEL.
 */
async function handleReviewRequestReaction(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.item.type !== 'message') return;
  if (event.item.channel !== process.env.SLACK_REVIEW_CHANNEL) return;

  const message = await fetchMessage(event.item.channel, event.item.ts);
  if (!message) {
    console.warn('[Slack] 👀 — could not fetch original message');
    return;
  }

  // conversations.history only returns top-level messages, so a ts mismatch means
  // the reaction was on a thread reply — don't review the root message's PR.
  if (message.ts !== event.item.ts) {
    console.log(`[Slack] 👀 on thread reply — skipping review (reacted ts=${event.item.ts}, root ts=${message.ts})`);
    return;
  }

  const cleanText = (message.text || '').replace(/<([^>]+)>/g, '$1');
  const prUrls = [...new Set(cleanText.match(/https:\/\/github\.com\/[^|\s]+\/pull\/\d+/g) || [])];
  if (prUrls.length === 0) {
    console.log('[Slack] 👀 — no PR URL in message');
    return;
  }

  console.log(`[Slack] 👀 — reviewing ${prUrls.length} PR(s)`);

  for (const prUrl of prUrls) {
    await runReviewForPr(prUrl, event.item.channel, event.item.ts);
  }
}

/**
 * The findings recap appended to the completion message: the run's own
 * Slack-formatted digest when it produced one, otherwise a bare per-severity
 * count. Returns '' when the run reported neither — we never invent zeros.
 */
function formatFindingsSummary({ summary, counts }) {
  if (summary) return `\n\n${summary}`;
  if (counts) return ` (🔴 ${counts.high} High · 🟡 ${counts.medium} Medium · 🟢 ${counts.low} Low)`;
  return '';
}

/**
 * The verdict badge line — e.g. `✅ *Ready to merge* — no blocking issues found.`
 * Returns '' when the run reported no verdict. When the verdict clears the PR
 * (see `shouldAutoApprove`) the bot also approves it on GitHub and appends
 * `formatAutoApprovalLine` below this badge.
 */
function formatVerdictLine(verdict) {
  if (!verdict) return '';
  return verdict.reason
    ? `\n*${verdict.label}* — ${verdict.reason}`
    : `\n*${verdict.label}*`;
}

/**
 * Whether the run's outcome clears the PR for an automatic GitHub approval:
 * an explicit `APPROVE` verdict, or a run that found nothing worth posting.
 * A `REQUEST_CHANGES` verdict always blocks — a run that says the PR needs work
 * but posted nothing is a contradiction we resolve on the safe side.
 *
 * @param {{commentUrl?: string|null, verdict?: {verdict: string}|null}} result
 * @returns {boolean}
 */
function shouldAutoApprove({ commentUrl, verdict }) {
  if (verdict?.verdict === 'REQUEST_CHANGES') return false;
  return verdict?.verdict === 'APPROVE' || !commentUrl;
}

/** Body posted with the GitHub APPROVE review, so the approval explains itself. */
function autoApproveBody(verdict) {
  return verdict?.reason
    ? `✅ Auto-approved after an automated code review — ${verdict.reason}`
    : '✅ Auto-approved after an automated code review — no blocking findings.';
}

/**
 * The completion reply for an approved PR. The approval subsumes both the
 * "review is complete" line and the `✅ Ready to merge` badge — repeating either
 * one under a ✅ just says the same thing three times — so this replaces them,
 * keeping only the verdict's reason, the review link and the findings digest.
 */
function formatApprovedText({ commentUrl, verdict, summary, counts }) {
  const head = `✅ *Approved on GitHub* — ${verdict?.reason || 'no blocking findings.'}`;
  // Nothing posted → no link and no recap; a stale `counts: {0,0,0}` would
  // otherwise tack "(🔴 0 High · …)" onto a review that reported nothing.
  if (!commentUrl) return head;
  return `${head} · <${commentUrl}|full review>${formatFindingsSummary({ summary, counts })}`;
}

/**
 * Block Kit body for a completion reply that still has open findings: the text
 * itself plus a `🔍 Review #<n> again` button, so whoever pushes the fixes can
 * re-run the review from the thread instead of re-reacting with 👀.
 *
 * @param {string} text - the Slack-mrkdwn completion message
 * @param {string} prUrl - carried in the button's value; the click handler needs it
 * @param {string} prNumber
 */
function reviewAgainBlocks(text, prUrl, prNumber) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: REVIEW_AGAIN_ACTION,
        text: { type: 'plain_text', text: `🔍 Review #${prNumber} again`, emoji: true },
        value: prUrl,
      }],
    },
  ];
}

/**
 * A `🔍 Review #<n> again` click. Anyone in the channel can press it — a teammate
 * who just pushed fixes usually wants the re-review more than I do — so the only
 * guard is a per-PR budget of MAX_TEAMMATE_REVIEWS runs for everyone but me.
 * A click that can't start a run (budget spent, review already in flight) is
 * answered ephemerally and costs nothing.
 */
async function handleReviewAgainClick(payload, action) {
  const prUrl = action.value;
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const userId = payload.user?.id;
  const channel = payload.channel?.id;
  // The button lives on a thread reply, so thread_ts is the root we reply into.
  const threadTs = payload.message?.thread_ts || payload.message?.ts;
  const isOwner = userId === process.env.MY_SLACK_USER_ID;

  if (!prUrl || !channel || !threadTs) {
    console.warn('[Review again] incomplete interaction payload — ignoring');
    return;
  }

  // Checked before the budget so a double-click doesn't burn a teammate's slot.
  if (reviewsInFlight.has(prUrl)) {
    await respondEphemeral(payload.response_url, `PR #${prNumber} is being reviewed right now — results will land in this thread.`);
    return;
  }

  if (!isOwner) {
    const used = teammateReviewRuns.get(prUrl) || 0;
    if (used >= MAX_TEAMMATE_REVIEWS) {
      console.log(`[Review again] PR #${prNumber} hit the teammate limit (${used}/${MAX_TEAMMATE_REVIEWS}) — click by ${userId} ignored`);
      await respondEphemeral(
        payload.response_url,
        `PR #${prNumber} has already been re-reviewed ${MAX_TEAMMATE_REVIEWS} times from this button. Ask <@${process.env.MY_SLACK_USER_ID}> to run it again.`
      );
      return;
    }
    teammateReviewRuns.set(prUrl, used + 1);
    console.log(`[Review again] PR #${prNumber} re-review ${used + 1}/${MAX_TEAMMATE_REVIEWS} by ${userId}`);
  } else {
    console.log(`[Review again] PR #${prNumber} re-review by owner ${userId} (unlimited)`);
  }

  await runReviewForPr(prUrl, channel, threadTs);
}

/**
 * Block Kit body for the "Starting code review..." reply: the text itself plus
 * a `Cancel review of #<n>` button, so a review that's taking too long (or was
 * started by mistake) can be stopped without waiting it out.
 *
 * @param {string} text
 * @param {string} prUrl - carried in the button's value; the click handler needs it
 * @param {string} prNumber
 */
function cancelReviewBlocks(text, prUrl, prNumber) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: REVIEW_CANCEL_ACTION,
        text: { type: 'plain_text', text: `Cancel review of #${prNumber}`, emoji: true },
        value: prUrl,
        style: 'danger',
      }],
    },
  ];
}

/**
 * A `Cancel review of #<n>` click. Unlike "Review again", only MY_SLACK_USER_ID
 * may cancel — a teammate clicking it gets an ephemeral "only you can cancel"
 * instead of actually stopping the run. Killing the `claude` process is
 * best-effort: anything it already posted to GitHub before the kill stays
 * posted, this only stops further work.
 */
async function handleReviewCancelClick(payload, action) {
  const prUrl = action.value;
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const userId = payload.user?.id;
  const channel = payload.channel?.id;
  const threadTs = payload.message?.thread_ts || payload.message?.ts;

  if (!prUrl || !channel || !threadTs) {
    console.warn('[Review cancel] incomplete interaction payload — ignoring');
    return;
  }

  if (userId !== process.env.MY_SLACK_USER_ID) {
    console.log(`[Review cancel] PR #${prNumber} cancel click by non-owner ${userId} — ignored`);
    await respondEphemeral(payload.response_url, `Only <@${process.env.MY_SLACK_USER_ID}> can cancel a review.`);
    return;
  }

  if (!reviewsInFlight.has(prUrl)) {
    await respondEphemeral(payload.response_url, `PR #${prNumber} isn't currently under review — nothing to cancel.`);
    return;
  }

  if (!cancelReview(prUrl)) {
    // Rare race: the run's `claude` process hadn't spawned yet, or already
    // closed, between the in-flight check above and this call.
    await respondEphemeral(payload.response_url, `Couldn't cancel PR #${prNumber} right now — try again in a moment.`);
    return;
  }

  console.log(`[Review cancel] PR #${prNumber} cancelled by ${userId}`);
  await replyToThread(
    channel,
    threadTs,
    `❌ Review of PR #${prNumber} cancelled by <@${userId}>.`,
    { notify: false }
  );
}

async function runReviewForPr(prUrl, channel, threadTs) {
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];

  // Clickable jump back to the reacted message. Empty when SLACK_WORKSPACE is unset.
  const threadLink = buildThreadLink(channel, threadTs);
  const threadLine = threadLink ? `\n<${threadLink}|Go to thread>` : '';

  if (reviewsInFlight.has(prUrl)) {
    console.log(`[Review] PR #${prNumber} already under review — ignoring duplicate 👀`);
    return;
  }

  // Check restrictions (allowed repo, local clone present) before announcing
  // anything in the team thread — an unreviewable PR should never leave a
  // dangling "Starting code review" with no follow-up.
  const skipReason = reviewSkipReason(prUrl);
  if (skipReason) {
    console.log(`[Review] skipping PR #${prNumber}: ${skipReason}`);
    await preview(`⏭️ *Code review skipped* — PR <${prUrl}|#${prNumber}>\n\`${skipReason}\`${threadLine}`);
    return;
  }

  reviewsInFlight.add(prUrl);

  try {
    // notify: false on both replies — suppresses the per-reply "✅ Replied in
    // Slack" preview. On success the team thread reply is the only output;
    // only a failure additionally pings the preview channel (see below).
    const startText = `Starting code review for PR #${prNumber}. Will post results here shortly.`;
    await replyToThread(channel, threadTs, startText, {
      notify: false,
      blocks: cancelReviewBlocks(startText, prUrl, prNumber),
    });

    const result = await runPrReview(prUrl);

    if (result.cancelled) {
      // handleReviewCancelClick already replied in the thread — nothing more to say.
      console.log(`[Review] PR #${prNumber} cancelled`);
      return;
    }

    if (!result.ok) {
      // Failures stay in my preview channel — no half-finished status in the team thread.
      await preview(`⚠️ *Code review failed* — PR <${prUrl}|#${prNumber}>\n\`${result.error}\`${threadLine}`);
      return;
    }

    // A clean run approves the PR on GitHub before the thread is told about it,
    // so the completion message can say it's approved rather than merely ready.
    // Like the ✅ teammate flow, this ignores DRY_RUN. A failed approval is
    // reported to the preview channel only — the thread never claims an
    // approval that didn't happen.
    let approved = false;
    if (shouldAutoApprove(result)) {
      approved = await approvePr(prUrl, autoApproveBody(result.verdict));
      if (approved) {
        // Visual confirmation on the message that started this — the same
        // ✅ a human would leave, so the channel can see it's done at a glance.
        // A failure here (e.g. missing reactions:write scope) is surfaced —
        // it used to fail silently into server logs no one was watching.
        const reacted = await reactToMessage(channel, threadTs, 'white_check_mark');
        if (!reacted.ok) {
          await preview(
            `⚠️ *PR approved, but the :white_check_mark: reaction failed* — PR <${prUrl}|#${prNumber}>\n\`${reacted.error}\`${threadLine}`,
            { tag: false }
          );
        }
      } else {
        await preview(
          `⚠️ *PR auto-approve failed* — PR <${prUrl}|#${prNumber}>${threadLine}`,
          { tag: false }
        );
      }
    }

    // Nothing posted → the digest/counts recap would be redundant noise (and,
    // with a stale `counts: {0,0,0}`, misleading); only the verdict still applies.
    let doneText;
    if (approved) {
      doneText = formatApprovedText(result);
    } else if (result.commentUrl) {
      doneText = `The review is complete; please view it <${result.commentUrl}|here>.${formatVerdictLine(result.verdict)}${formatFindingsSummary(result)}`;
    } else {
      doneText = `The review is complete — no findings to post.${formatVerdictLine(result.verdict)}`;
    }

    // Open findings → offer a one-click re-review for after the fixes are pushed.
    // An approved PR needs no second pass, and a run that posted nothing has no
    // findings to fix, so neither gets a button.
    const showReviewAgain = !approved && Boolean(result.commentUrl);
    await replyToThread(channel, threadTs, doneText, {
      notify: false,
      ...(showReviewAgain ? { blocks: reviewAgainBlocks(doneText, prUrl, prNumber) } : {}),
    });
  } finally {
    reviewsInFlight.delete(prUrl);
  }
}

// ─── Slack Interactivity (Block Kit buttons) ──────────────────────────────────

/**
 * POST /slack/interactive — Slack sends every block action here as a
 * form-encoded `payload` JSON string. Handles the `🔍 Review #<n> again` button
 * on a completion reply and the `Cancel review of #<n>` button on the
 * "Starting code review..." reply.
 */
app.post('/slack/interactive', async (req, res) => {
  // Slack wants the ack inside 3 seconds; a review takes minutes.
  res.sendStatus(200);

  if (!verifySlackSignature(req)) {
    console.warn('[Slack interactive] Invalid signature — request ignored');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(req.body?.payload || '{}');
  } catch (err) {
    console.warn('[Slack interactive] unparseable payload:', err.message);
    return;
  }

  if (payload.type !== 'block_actions') return;

  const action = (payload.actions || [])[0];
  if (action?.action_id === REVIEW_AGAIN_ACTION) {
    await handleReviewAgainClick(payload, action);
  } else if (action?.action_id === REVIEW_CANCEL_ACTION) {
    await handleReviewCancelClick(payload, action);
  }
});

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
