'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { transitionIssue, addComment, getIssue, getIssueSummary } = require('./jira');
const { replyToThread, fetchMessage, searchMyMessages, preview, buildThreadLink, respondEphemeral, postToChannel, fetchThreadMessages, replaceOriginal, reactToMessage, deleteMessage, fetchThreadReply, deleteStartingReviewMessages, clearChannelHistory, deleteThread } = require('./slack');
const { extractJiraKey, extractAllJiraKeys, extractSlackThread, extractPrUrls } = require('./utils');
const { fetchPrTitle, fetchPrData, fetchPrCommits, approvePr } = require('./github');
const { runPrReview, reviewSkipReason, cancelReview } = require('./review');
const { runClientReport, extractSessionId, extractNotePaths, deleteClientReportNote, sessionLine } = require('./clientReport');

const ALLOWED_BASE_BRANCHES = ['develop', 'releasing_staging', 'main', 'master'];
const NOTIFY_BASE_BRANCHES = ['develop', 'releasing_staging'];
const REVIEW_REACTION = 'eyes';
const DELETE_STARTING_REVIEWS_REACTION = 'wastebasket';

// Review model by who posted the PR: my own PRs get the stronger model, a
// teammate's get the cheaper one.
const OWNER_REVIEW_MODEL = 'claude-sonnet-5-5';
const TEAMMATE_REVIEW_MODEL = 'claude-haiku-5-5';

/** Model for reviewing a PR posted by Slack user `authorId` (unknown → teammate model). */
function reviewModelFor(authorId) {
  return authorId && authorId === process.env.MY_SLACK_USER_ID ? OWNER_REVIEW_MODEL : TEAMMATE_REVIEW_MODEL;
}

const REVIEW_AGAIN_ACTION = 'review_pr_again';
const REVIEW_CANCEL_ACTION = 'review_pr_cancel';
const REVIEW_ACK_ACTION = 'review_pr_ack';
const CLIENT_REPORT_STOP_ACTION = 'client_report_stop';
// How many times teammates (anyone but me) may re-run a review from the button,
// per PR. I'm unlimited — the cap only stops the button being hammered.
const MAX_TEAMMATE_REVIEWS = 2;

// PR URLs with a Claude review currently running — a second 👀 on the same PR is
// ignored until the first run finishes (reviews take minutes and post to GitHub).
const reviewsInFlight = new Set();

// `<channel>:<ts>` of client-report threads being investigated — same duplicate
// guard as `reviewsInFlight`, so a second 👀 can't start a second investigation.
const clientReportsInFlight = new Set();

// PR URL → number of "Review again" runs started by teammates. In memory only,
// so a restart clears the budget; the cap is a courtesy guard, not a quota.
const teammateReviewRuns = new Map();

// PR URLs whose latest completed review left only P3 findings and offered the
// "noted, not fixing now" button. The click re-checks this so a button on an
// older reply can't approve a PR whose newer review found something worse (or
// that is being re-reviewed). In memory only — after a restart the button says
// to run "Review again", which is the safe direction.
const acknowledgeablePrs = new Set();

// PR URL → head commit SHA of the last review that completed. "Review again"
// compares it with the PR's current head and refuses when nothing was pushed
// since. Set only on a finished run (a failed or cancelled one reviewed
// nothing), in memory only — after a restart there's no record, which allows
// the click (the safe direction).
const reviewedHeadShas = new Map();

/**
 * Review channels, from SLACK_REVIEW_CODE_CHANNEL — one channel ID or several
 * comma-separated (`C05F65TBB9P,C073WMRV127`). Read on every call so a changed
 * env value is picked up without a restart-order dependency (and tests can set it).
 *
 * @returns {string[]}
 */
function reviewChannels() {
  return (process.env.SLACK_REVIEW_CODE_CHANNEL || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

/** Whether `channel` is one of the configured review channels. */
function isReviewChannel(channel) {
  return Boolean(channel) && reviewChannels().includes(channel);
}

/**
 * Client-report channels, from SLACK_CLIENT_REPORT_CHANNEL — one channel ID or
 * several comma-separated. A 👀 on a root message there runs the everfit-api
 * `client-report` skill instead of a PR review.
 *
 * @returns {string[]}
 */
function clientReportChannels() {
  return (process.env.SLACK_CLIENT_REPORT_CHANNEL || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

/**
 * My private channel for client reports (SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT):
 * each 👀 copies the report here and the investigation's replies live in that
 * copy's thread — permanent, unlike an ephemeral message — and a hint I write in
 * the thread continues the investigation. Empty string when unset.
 */
function clientReportPrivateChannel() {
  return (process.env.SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT || '').trim();
}

// Marks the root of a copied report, so only those threads take follow-up hints.
const CLIENT_REPORT_COPY_HEADER = '📋 *Client report*';
// Slack returns unicode emoji as `:shortcode:` in a stored message's text, so the
// root is recognised in either form.
const CLIENT_REPORT_COPY_RE = /^(?:📋|:clipboard:) \*Client report\*/;
const CLIENT_REPORT_START_TEXT = 'Starting client report investigation. Will post results here shortly.';
const CLIENT_REPORT_CONTINUE_TEXT = 'Continuing the investigation with your hint. Will post results here shortly.';
const CLIENT_REPORT_HINT_TIP = '💬 _Reply in this thread with a hint to keep investigating._';

/** Whether `channel` is one of the configured client-report channels. */
function isClientReportChannel(channel) {
  return Boolean(channel) && clientReportChannels().includes(channel);
}

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
    if (event.channel && event.channel === clientReportPrivateChannel()) {
      // A hint written in a copied client report's thread → continue the investigation
      await handleClientReportFollowUp(event);
    } else {
      await handleReviewMessage(event);
    }
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
  } else if (event.type === 'reaction_added' && event.reaction === DELETE_STARTING_REVIEWS_REACTION) {
    // 🗑️ on a root message → sweep its thread and delete stray "Starting review" messages
    // 🗑️ on one of the bot's thread replies → delete that reply
    await handleDeleteStartingReviewsReaction(event);
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

  if (command === '/clear-history') {
    runClearHistoryCommand(text, response_url).catch(err => {
      console.log('[Slack cmd] /clear-history failed:', err.message);
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

/**
 * `/clear-history [YYYY-MM-DD|all]` — deletes the bot's own messages in
 * SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE for one day (Asia/Bangkok, default today) or all of them.
 */
async function runClearHistoryCommand(text, responseUrl) {
  const arg = (text || '').trim().toLowerCase() || todayInBangkok();
  const all = arg === 'all';

  if (!all && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    await postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      text: `❌ Invalid date \`${arg}\` — use YYYY-MM-DD or \`all\`.`,
    });
    return;
  }

  const channel = process.env.SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE;
  if (!channel) {
    await postToResponseUrl(responseUrl, {
      response_type: 'ephemeral',
      text: '❌ `SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE` is not set — nothing to clear.',
    });
    return;
  }

  const { deleted, failed } = await clearChannelHistory(channel, all ? null : arg);
  const scope = all ? 'all history' : arg;
  await postToResponseUrl(responseUrl, {
    response_type: 'ephemeral',
    text: `🧹 Cleared ${deleted} message${deleted === 1 ? '' : 's'} from the preview channel (${scope})${failed ? ` — ${failed} could not be deleted` : ''}.`,
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
  if (!isReviewChannel(event.channel)) return;

  // Root messages only — ignore thread replies
  if (event.thread_ts && event.thread_ts !== event.ts) return;

  const text = event.text || '';

  // Must contain a GitHub PR link (in the text or behind a hyperlink label)
  const [prUrl] = extractPrUrls(event);
  if (!prUrl) return;

  // Try extracting Jira key from message text first, fallback to PR title
  let jiraKey = extractJiraKey(text);

  if (!jiraKey) {
    const prTitle = await fetchPrTitle(prUrl);
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
  if (!isReviewChannel(event.item.channel)) return;

  // Fetch the original message to extract Jira key and PR URL
  const message = await fetchMessage(event.item.channel, event.item.ts);
  if (!message) {
    console.warn('[Slack] reaction_added: could not fetch original message');
    return;
  }

  const text = message.text || '';
  const [prUrl] = extractPrUrls(message);
  if (!prUrl) {
    console.log('[Slack] reaction_added: no PR URL in message');
    return;
  }
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
  if (!isReviewChannel(event.item.channel)) return;

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

  const prUrls = extractPrUrls(message);
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
 * SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE.
 */
async function handleReviewRequestReaction(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.item.type !== 'message') return;
  if (isClientReportChannel(event.item.channel)) return handleClientReportReaction(event);
  if (!isReviewChannel(event.item.channel)) return;

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

  const prUrls = extractPrUrls(message);
  if (prUrls.length === 0) {
    console.log('[Slack] 👀 — no PR URL in message');
    return;
  }

  console.log(`[Slack] 👀 — reviewing ${prUrls.length} PR(s)`);

  // Concurrent, not sequential: each PR's run is independent (own in-flight key,
  // own `claude` process, own thread replies), so a slow first review shouldn't
  // hold up the rest. allSettled so one PR blowing up can't abort the others.
  const results = await Promise.allSettled(
    prUrls.map(prUrl => runReviewForPr(prUrl, event.item.channel, event.item.ts, message.user ?? null))
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`[Review] ${prUrls[i]} failed unexpectedly:`, result.reason);
    }
  });
}

/**
 * 👀 on a root message in a SLACK_CLIENT_REPORT_CHANNEL channel → copies the
 * report into my private SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT channel, runs
 * the everfit-api `client-report` skill (`investigate` mode) on the original
 * thread, and posts the Vietnamese summary as a reply to that copy — a permanent
 * record, nothing public. A hint I then write in the copy's thread continues the
 * investigation (`handleClientReportFollowUp`). Failures are replies there too.
 */
async function handleClientReportReaction(event) {
  const { channel, ts } = event.item;

  const message = await fetchMessage(channel, ts);
  if (!message) {
    console.warn('[Slack] 👀 (client report) — could not fetch original message');
    return;
  }
  if (message.ts !== ts) {
    console.log(`[Slack] 👀 (client report) on thread reply — skipping (reacted ts=${ts}, root ts=${message.ts})`);
    return;
  }

  const key = `${channel}:${ts}`;
  if (clientReportsInFlight.has(key)) {
    console.log(`[ClientReport] ${key} already under investigation — ignoring duplicate 👀`);
    return;
  }

  // The skill only accepts `<workspace>.slack.com/archives/...` permalinks.
  const threadLink = buildThreadLink(channel, ts);
  if (!threadLink) {
    await preview('⏭️ *Client report skipped*\n`SLACK_WORKSPACE is not set — cannot build the thread link the skill needs`');
    return;
  }
  const privateChannel = clientReportPrivateChannel();
  if (!privateChannel) {
    await preview('⏭️ *Client report skipped*\n`SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT is not set — nowhere to post the result`');
    return;
  }

  clientReportsInFlight.add(key);
  try {
    const author = message.user ? ` · posted by <@${message.user}>` : '';
    const copyTs = await postToChannel(
      privateChannel,
      `${CLIENT_REPORT_COPY_HEADER} — <${threadLink}|original thread>${author}\n\n${message.text || ''}`
    );
    if (!copyTs) {
      await preview(`⚠️ *Client report failed*\n\`couldn't copy the message into SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT\`\n<${threadLink}|Go to thread>`);
      return;
    }

    console.log(`[ClientReport] investigating ${threadLink}`);
    const statusTs = await postToChannel(privateChannel, CLIENT_REPORT_START_TEXT, { threadTs: copyTs });
    const result = await runClientReport(threadLink, { model: clientReportModel() });
    await clearClientReportStatus(privateChannel, statusTs);
    await postClientReportResult(privateChannel, copyTs, result);
  } finally {
    clientReportsInFlight.delete(key);
  }
}

/**
 * A reply of mine inside a copied client report in SLACK_BOT_PRIVATE_CHANNEL_CLIENT_REPORT
 * is a hint: the investigation resumes in the same claude session (its id is read
 * back from the bot's earlier replies, so it survives a restart) and the new
 * summary is posted in the thread. With no session on record it re-runs on the
 * original thread with the hint as extra symptom text.
 */
async function handleClientReportFollowUp(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.subtype || event.bot_id) return;
  // Thread replies only — a top-level post in the channel is just a note.
  if (!event.thread_ts || event.thread_ts === event.ts) return;
  const hint = (event.text || '').trim();
  if (!hint) return;

  const channel = event.channel;
  const threadTs = event.thread_ts;

  const messages = await fetchThreadMessages(channel, threadTs);
  const root = messages[0];
  if (!CLIENT_REPORT_COPY_RE.test(root?.text || '')) return;

  const key = `${channel}:${threadTs}`;
  if (clientReportsInFlight.has(key)) {
    await postToChannel(channel, '⏳ Still investigating — send your hint again once the summary lands.', { threadTs });
    return;
  }

  const originalLink = root.text.match(/https:\/\/[^\s|>]+\/archives\/[^\s|>]+/)?.[0];
  const sessionId = extractSessionId(messages);
  if (!originalLink && !sessionId) {
    await postToChannel(channel, '⚠️ Couldn\'t find the original thread or an earlier session in this thread — react 👀 on the report again.', { threadTs });
    return;
  }

  clientReportsInFlight.add(key);
  try {
    console.log(`[ClientReport] follow-up in ${key} (${sessionId ? `session ${sessionId}` : 'no session — fresh run'})`);
    const statusTs = await postToChannel(channel, CLIENT_REPORT_CONTINUE_TEXT, { threadTs });
    const result = await runClientReport(originalLink, {
      model: clientReportModel(),
      hint,
      resumeSessionId: sessionId || undefined,
    });
    await clearClientReportStatus(channel, statusTs);
    await postClientReportResult(channel, threadTs, result);
  } finally {
    clientReportsInFlight.delete(key);
  }
}

/**
 * Deletes the "Starting…" status reply once the run is over — like the PR
 * review's "Starting code review" cleanup, so it never lingers next to the
 * result. Done for failures too: the failure reply follows it. Best-effort
 * (deleteMessage never throws); a no-op when the status post itself failed.
 */
async function clearClientReportStatus(channel, statusTs) {
  if (!statusTs) return;
  await deleteMessage(channel, statusTs, { ignoreDryRun: true });
}

/** `--model` for client-report runs: CLIENT_REPORT_MODEL, else the cheap model. */
function clientReportModel() {
  return process.env.CLIENT_REPORT_MODEL || TEAMMATE_REVIEW_MODEL;
}

/**
 * Posts a client-report run's outcome as a reply in the copied report's thread:
 * the Vietnamese summary (or a fallback notice) + the session footer + the hint
 * tip, or the error.
 */
async function postClientReportResult(channel, threadTs, result) {
  if (!result.ok) {
    const text = `⚠️ *Client report failed*\n\`${result.error}\`\n${CLIENT_REPORT_HINT_TIP}`;
    await postToChannel(channel, text, { threadTs, blocks: clientReportStopBlocks(text) });
    return;
  }
  const body = result.summary
    || '✅ Đã chạy xong client-report nhưng không có tóm tắt — xem ghi chú trong `ai-agents-output/client-reports-checking/` của repo everfit-api.';
  const text = `${body}\n\n${sessionLine(result.sessionId)}\n${CLIENT_REPORT_HINT_TIP}`;
  await postToChannel(channel, text, { threadTs, blocks: clientReportStopBlocks(text) });
}

/**
 * Block Kit body for a client-report result: the text plus a `Stop & delete`
 * button that wipes the whole thread and the note the skill saved.
 */
function clientReportStopBlocks(text) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: CLIENT_REPORT_STOP_ACTION,
        text: { type: 'plain_text', text: '🛑 Stop & delete', emoji: true },
        value: 'stop',
        style: 'danger',
        confirm: {
          title: { type: 'plain_text', text: 'Stop this report?' },
          text: { type: 'mrkdwn', text: 'Deletes this whole thread and the saved note in everfit-api.' },
          confirm: { type: 'plain_text', text: 'Delete' },
          deny: { type: 'plain_text', text: 'Keep' },
        },
      }],
    },
  ];
}

/**
 * A `🛑 Stop & delete` click: deletes the saved note file(s) the thread
 * mentions, then every message of the thread (replies, then the copied root).
 * Owner-only; refused while an investigation is still running in the thread.
 */
async function handleClientReportStopClick(payload) {
  const userId = payload.user?.id;
  const channel = payload.channel?.id;
  const threadTs = payload.message?.thread_ts || payload.message?.ts;
  if (!channel || !threadTs) {
    console.warn('[ClientReport stop] incomplete interaction payload — ignoring');
    return;
  }
  if (userId !== process.env.MY_SLACK_USER_ID) {
    await respondEphemeral(payload.response_url, `Only <@${process.env.MY_SLACK_USER_ID}> can stop a client report.`);
    return;
  }
  if (channel !== clientReportPrivateChannel()) return;
  if (clientReportsInFlight.has(`${channel}:${threadTs}`)) {
    await respondEphemeral(payload.response_url, '⏳ Still investigating — try again once the summary lands.');
    return;
  }

  const messages = await fetchThreadMessages(channel, threadTs);
  if (!CLIENT_REPORT_COPY_RE.test(messages[0]?.text || '')) return;

  const notes = extractNotePaths(messages);
  const noteResults = notes.map(note => ({ note, ...deleteClientReportNote(note) }));
  const { deleted, failed } = await deleteThread(channel, threadTs);
  console.log(`[ClientReport stop] ${channel}:${threadTs} — ${deleted} message(s) deleted, ${failed} failed, notes: ${notes.join(', ') || 'none'}`);
  for (const r of noteResults.filter(n => !n.ok)) console.error(`[ClientReport stop] note not deleted: ${r.note} (${r.error})`);
}

/**
 * 🗑️ on a message in #backend-review-code → sweeps that message's thread and
 * deletes every "Starting code review for PR #<n>..." message still sitting in
 * it, for any PR. A manual escape hatch: `runReviewForPr`'s own cleanup only
 * fires once a run resolves, so a run that crashes outright (`claude` missing,
 * an untrusted workspace, etc.) never gets there and leaves the message stuck
 * — react 🗑️ on the thread to clear it out by hand.
 */
async function handleDeleteStartingReviewsReaction(event) {
  if (event.user !== process.env.MY_SLACK_USER_ID) return;
  if (event.item.type !== 'message') return;
  if (!isReviewChannel(event.item.channel)) return;

  const channel = event.item.channel;
  const threadTs = event.item.ts;

  const message = await fetchMessage(channel, threadTs);
  if (!message) {
    console.warn('[Slack] 🗑️ — could not fetch reacted message');
    return;
  }
  // Same top-level-only limitation as the 👀 flow: conversations.history returns
  // the nearest top-level message, so a ts mismatch means this was a thread reply.
  if (message.ts !== threadTs) {
    await handleDeleteBotReply(channel, threadTs);
    return;
  }

  const deleted = await deleteStartingReviewMessages(channel, threadTs);

  console.log(`[Slack] 🗑️ — deleted ${deleted} "Starting review" message(s) in ${channel}/${threadTs}`);
  await preview(
    `🗑️ *Deleted ${deleted} "Starting review" message${deleted === 1 ? '' : 's'}*`,
    { tag: false }
  );
}

/**
 * 🗑️ on a thread reply → deletes it when the bot posted it (the "Starting code
 * review...", completion, approval and cancellation replies). Anything a person
 * wrote is left alone — the bot's `bot_id` is the discriminator, and Slack
 * itself only lets the bot delete its own messages. One untagged preview says
 * what happened; a refused delete is surfaced there too instead of vanishing.
 */
async function handleDeleteBotReply(channel, ts) {
  const reply = await fetchThreadReply(channel, ts);
  if (!reply) {
    console.log(`[Slack] 🗑️ — could not fetch thread reply ${ts}`);
    return;
  }
  if (!reply.bot_id) {
    console.log(`[Slack] 🗑️ on a reply not posted by a bot (${ts}) — skipping`);
    return;
  }

  const result = await deleteMessage(channel, ts);
  if (!result.ok) {
    await preview(`⚠️ *Couldn't delete the bot's reply*\n\`${result.error}\``, { tag: false });
    return;
  }
  console.log(`[Slack] 🗑️ — deleted bot reply ${ts} in ${channel}`);
  await preview(`🗑️ *Deleted the bot's reply*`, { tag: false });
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
function formatApprovedText({ commentUrl, verdict, summary, counts }, prNumber) {
  const head = `✅ *PR #${prNumber} approved on GitHub* — ${verdict?.reason || 'no blocking findings.'}`;
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
 * @param {{acknowledge?: boolean}} [opts] - `acknowledge` adds the green
 *   `👍 #<n> noted, not fixing now` button (see `isAcknowledgeable`)
 */
function reviewAgainBlocks(text, prUrl, prNumber, { acknowledge = false } = {}) {
  const elements = [{
    type: 'button',
    action_id: REVIEW_AGAIN_ACTION,
    text: { type: 'plain_text', text: `🔍 Review #${prNumber} again`, emoji: true },
    value: prUrl,
  }];
  if (acknowledge) {
    elements.push({
      type: 'button',
      action_id: REVIEW_ACK_ACTION,
      text: { type: 'plain_text', text: `👍 #${prNumber} noted, not fixing now`, emoji: true },
      value: prUrl,
      style: 'primary',
    });
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements },
  ];
}

/**
 * Whether a completed review is one the PR owner may wave through with the
 * "noted, not fixing now" button: findings were posted, but all of them are
 * 🟢 P3 (Low) — no 🔴 P1 (High) and no 🟡 P2 (Medium) — and the verdict isn't
 * `REQUEST_CHANGES`. Unknown counts (the run reported none) never qualify: we
 * don't wave through a review we can't read. A clean `APPROVE` is auto-approved
 * before this is ever asked, so in practice this covers the `COMMENT` verdict
 * (the model hedged on P3s) and an `APPROVE` whose GitHub approval failed.
 *
 * @param {{commentUrl?: string|null, counts?: {high: number, medium: number, low: number}|null, verdict?: {verdict: string}|null}} result
 * @returns {boolean}
 */
function isAcknowledgeable({ commentUrl, counts, verdict }) {
  if (!commentUrl || !counts) return false;
  if (verdict?.verdict === 'REQUEST_CHANGES') return false;
  return counts.high === 0 && counts.medium === 0 && counts.low > 0;
}

/**
 * The PR number in a button's label (`action.text.text`) when it disagrees with
 * the PR in the button's `value` URL; null when they agree or the label carries
 * no number to compare. Label and value are built from the same PR, so a
 * mismatch means a stale or tampered button.
 */
function mismatchedLabelNumber(action, prNumber) {
  const labelNumber = action.text?.text?.match(/#(\d+)/)?.[1];
  return labelNumber && labelNumber !== prNumber ? labelNumber : null;
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

  // Don't review a PR other than the one the button's label says it is. Slack
  // echoes the label back as `action.text.text`; no number → nothing to compare.
  const labelNumber = mismatchedLabelNumber(action, prNumber);
  if (labelNumber) {
    console.warn(`[Review again] button label says #${labelNumber} but value is PR #${prNumber} — ignoring`);
    await respondEphemeral(
      payload.response_url,
      `This button is for PR #${labelNumber} but points at PR #${prNumber}, so I didn't start a review. React with 👀 on the message to review it.`
    );
    return;
  }

  // Checked before the budget so a double-click doesn't burn a teammate's slot.
  const refuseIfInFlight = async () => {
    if (!reviewsInFlight.has(prUrl)) return false;
    await respondEphemeral(payload.response_url, `PR #${prNumber} is being reviewed right now — results will land in this thread.`);
    return true;
  };
  if (await refuseIfInFlight()) return;

  // Nothing pushed since the last review → a re-run would only repeat it. Fail
  // open: no record of a previous run, or GitHub unreachable, lets it through.
  const reviewedSha = reviewedHeadShas.get(prUrl);
  if (reviewedSha) {
    const current = await fetchPrData(prUrl);
    if (current?.headSha && current.headSha === reviewedSha) {
      console.log(`[Review again] PR #${prNumber} head ${current.headSha} already reviewed — click by ${userId} ignored`);
      await respondEphemeral(
        payload.response_url,
        `PR #${prNumber} has no new commits since the last review (latest commit \`${current.headSha.slice(0, 7)}\`), so I didn't start another one. Push your fixes, then click again.`
      );
      return;
    }
    // The lookup above is an await — another click may have started a run meanwhile.
    if (await refuseIfInFlight()) return;
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
 * A `👍 #<n> noted, not fixing now` click: the PR owner has read the P3-only
 * review and is choosing not to fix those findings. Approves the PR on GitHub,
 * ✅-reacts the message that carried the PR link, and swaps the completion
 * reply's buttons for a final status line.
 *
 * Allowed for whoever posted the PR link (the thread root's author — the PR's
 * owner as far as Slack can tell) and for me. Guards, in order: button label vs
 * PR, who clicked, a re-review already running, and the review result still
 * being the P3-only one the button was offered for. Every refusal is ephemeral.
 * Like the other approve flows this ignores DRY_RUN.
 */
async function handleReviewAckClick(payload, action) {
  const prUrl = action.value;
  const prNumber = prUrl?.match(/\/pull\/(\d+)/)?.[1];
  const userId = payload.user?.id;
  const channel = payload.channel?.id;
  const threadTs = payload.message?.thread_ts || payload.message?.ts;
  const me = process.env.MY_SLACK_USER_ID;

  if (!prUrl || !channel || !threadTs) {
    console.warn('[Review ack] incomplete interaction payload — ignoring');
    return;
  }

  const labelNumber = mismatchedLabelNumber(action, prNumber);
  if (labelNumber) {
    console.warn(`[Review ack] button label says #${labelNumber} but value is PR #${prNumber} — ignoring`);
    await respondEphemeral(
      payload.response_url,
      `This button is for PR #${labelNumber} but points at PR #${prNumber}, so I didn't approve anything. Run "Review again" if you still want to act on it.`
    );
    return;
  }

  if (userId !== me) {
    const root = await fetchMessage(channel, threadTs);
    if (!root?.user || root.user !== userId) {
      console.log(`[Review ack] PR #${prNumber} click by ${userId} — not the PR poster (${root?.user ?? 'unknown'}), ignored`);
      await respondEphemeral(
        payload.response_url,
        root?.user
          ? `Only <@${root.user}> (who posted this PR) or <@${me}> can mark these findings as noted.`
          : `Only <@${me}> can mark these findings as noted.`
      );
      return;
    }
  }

  if (reviewsInFlight.has(prUrl)) {
    await respondEphemeral(payload.response_url, `PR #${prNumber} is being reviewed right now — wait for the new result.`);
    return;
  }

  if (!acknowledgeablePrs.has(prUrl)) {
    await respondEphemeral(
      payload.response_url,
      `This review result is out of date for PR #${prNumber}. Click "Review again" to get a fresh one.`
    );
    return;
  }

  const threadLink = buildThreadLink(channel, threadTs);
  const threadLine = threadLink ? `\n<${threadLink}|Go to thread>` : '';

  const approved = await approvePr(
    prUrl,
    '👍 Acknowledged by the PR owner — only low-severity (P3) findings remain and they are not being fixed now. Approved after an automated code review.'
  );
  if (!approved) {
    await preview(`⚠️ *PR approve failed after "noted, not fixing now"* — PR <${prUrl}|#${prNumber}>${threadLine}`, { tag: false });
    await respondEphemeral(payload.response_url, `Couldn't approve PR #${prNumber} on GitHub — try again, or approve it manually.`);
    return;
  }
  acknowledgeablePrs.delete(prUrl);
  console.log(`[Review ack] PR #${prNumber} approved after P3-only acknowledgement by ${userId}`);

  const reacted = await reactToMessage(channel, threadTs, 'white_check_mark');
  if (!reacted.ok) {
    await preview(
      `⚠️ *PR approved, but the :white_check_mark: reaction failed* — PR <${prUrl}|#${prNumber}>\n\`${reacted.error}\`${threadLine}`,
      { tag: false }
    );
  }

  // The original reply minus its buttons, plus who decided what. Rebuilt from the
  // message's section block: Slack's `message.text` in an interaction payload is a
  // flattened fallback with the line breaks collapsed, which is how the digest
  // used to come back as one run-on paragraph. The status line gets its own block.
  // If Slack won't take the replacement (response_url lives 30 min), say it in the
  // thread instead.
  const status = `👍 <@${userId}> noted the P3 findings and is not fixing them now — ✅ *Approved on GitHub*.`;
  const original = payload.message?.blocks?.find(b => b.type === 'section' && b.text?.text)?.text.text
    || payload.message?.text;
  const section = text => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const replaced = await replaceOriginal(
    payload.response_url,
    original ? `${original}\n${status}` : status,
    { blocks: original ? [section(original), section(status)] : [section(status)] }
  );
  if (!replaced) {
    await replyToThread(channel, threadTs, `PR #${prNumber}: ${status}`, { notify: false });
  }
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

/**
 * @param {string|null} [authorId] - Slack user who posted the PR message, which
 *   picks the review model. `undefined` → looked up from the thread root (the
 *   "Review again" click only knows the thread); `null` → known to be unknown.
 */
async function runReviewForPr(prUrl, channel, threadTs, authorId) {
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

  // Marked in flight *before* the merged-state lookup below: that's an await, and
  // a second 👀/click landing during it must hit the duplicate guard above.
  reviewsInFlight.add(prUrl);

  try {
    // A merged PR has nothing left to review. Fail open: when GitHub can't be
    // reached `fetchPrData` returns null and the review proceeds as before.
    const prData = await fetchPrData(prUrl);
    if (prData?.merged) {
      console.log(`[Review] skipping PR #${prNumber}: already merged`);
      await preview(`⏭️ *Code review skipped* — PR <${prUrl}|#${prNumber}>\n\`PR is already merged\`${threadLine}`);
      return;
    }

    // A fresh run supersedes whatever the previous result allowed.
    acknowledgeablePrs.delete(prUrl);

    // notify: false on both replies — suppresses the per-reply "✅ Replied in
    // Slack" preview. On success the team thread reply is the only output;
    // only a failure additionally pings the preview channel (see below).
    const startText = `Starting code review for PR #${prNumber}. Will post results here shortly.`;
    await replyToThread(channel, threadTs, startText, {
      notify: false,
      blocks: cancelReviewBlocks(startText, prUrl, prNumber),
    });

    const author = authorId !== undefined ? authorId : (await fetchMessage(channel, threadTs))?.user;
    const model = reviewModelFor(author);
    console.log(`[Review] PR #${prNumber} posted by ${author || 'unknown'} → model ${model}`);

    const result = await runPrReview(prUrl, { model });

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

    // Remember which commit this review covered, for the "Review again" guard.
    if (prData?.headSha) reviewedHeadShas.set(prUrl, prData.headSha);

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
      doneText = formatApprovedText(result, prNumber);
    } else if (result.commentUrl) {
      doneText = `The review of PR #${prNumber} is complete; please view it <${result.commentUrl}|here>.${formatVerdictLine(result.verdict)}${formatFindingsSummary(result)}`;
    } else {
      doneText = `The review of PR #${prNumber} is complete — no findings to post.${formatVerdictLine(result.verdict)}`;
    }

    // The "Starting code review..." message(s) have served their purpose — a
    // thread can carry more than one for this PR (repeated "Review again" runs,
    // or ones left behind before this cleanup existed), so sweep and delete all
    // of them rather than just this run's own. Best-effort: doesn't block the
    // completion reply below.
    await deleteStartingReviewMessages(channel, threadTs, prNumber);

    // Open findings → offer a one-click re-review for after the fixes are pushed.
    // An approved PR needs no second pass, and a run that posted nothing has no
    // findings to fix, so neither gets a button.
    const showReviewAgain = !approved && Boolean(result.commentUrl);
    // P3-only findings can also be waved through by the PR owner (see isAcknowledgeable).
    const acknowledge = !approved && isAcknowledgeable(result);
    if (acknowledge) acknowledgeablePrs.add(prUrl);
    await replyToThread(channel, threadTs, doneText, {
      notify: false,
      ...(showReviewAgain ? { blocks: reviewAgainBlocks(doneText, prUrl, prNumber, { acknowledge }) } : {}),
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
  } else if (action?.action_id === REVIEW_ACK_ACTION) {
    await handleReviewAckClick(payload, action);
  } else if (action?.action_id === CLIENT_REPORT_STOP_ACTION) {
    await handleClientReportStopClick(payload);
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
