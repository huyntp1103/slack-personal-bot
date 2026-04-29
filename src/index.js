'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { transitionIssue, addComment, getIssue } = require('./jira');
const { replyToThread, fetchMessage } = require('./slack');
const { extractJiraKey, extractSlackThread } = require('./utils');
const { fetchPrTitle, fetchPrData, fetchPrCommits } = require('./github');

const ALLOWED_BASE_BRANCHES = ['develop', 'releasing_staging', 'main', 'master'];
const NOTIFY_BASE_BRANCHES = ['develop', 'releasing_staging'];

const app = express();

app.use(express.json({
  verify: (_req, _res, buf) => { _req.rawBody = buf; },
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
  } else if (event.type === 'reaction_added') {
    await handleReactionAdded(event);
  }
});

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
