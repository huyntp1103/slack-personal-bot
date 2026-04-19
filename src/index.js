'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const { transitionIssue, addComment, getIssue } = require('./jira');
const { replyToThread, fetchMessage } = require('./slack');
const { extractJiraKey, extractSlackThread } = require('./utils');
const { fetchPrTitle } = require('./github');

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

  // console.log(`[Slack] event type=${event.type} user=${event.user} channel=${event.channel} text=${JSON.stringify(event.text)}`);

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
 * ✅ reaction on my message in #backend-review-code → Jira: QA Ready + Slack thread
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

  let jiraKey = extractJiraKey(text);

  if (!jiraKey && prUrlMatch) {
    const prTitle = await fetchPrTitle(prUrlMatch[0]);
    if (prTitle) {
      jiraKey = extractJiraKey(prTitle);
      console.log(`[GitHub] PR title: "${prTitle}"`);
    }
  }

  if (!jiraKey) {
    console.log('[Slack] reaction_added: no Jira key found in message or PR title');
    return;
  }
  const prUrl = prUrlMatch ? prUrlMatch[0].replace(/\|.*$/, '') : '';

  // console.log(`[Slack] ✅ reaction detected — transitioning ${jiraKey} → QA Ready`);

  await transitionIssue(jiraKey, process.env.ID_QA_READY);
  await addComment(jiraKey, 'Ready for QA testing');

  try {
    const issue = await getIssue(jiraKey);
    const isBug = issue.fields.issuetype.name === 'Bug';

    if (isBug) {
      const thread = extractSlackThread(issue.fields.description);
      if (thread) {
        await replyToThread(
          thread.channel,
          thread.ts,
          `Dạ card này test được rồi ạ`
        );
      } else {
        console.log(`[Slack] Bug ${jiraKey} has no Slack thread link in Jira description`);
      }
    }
  } catch (err) {
    console.error(`[Slack] handleReactionAdded post-transition error (${jiraKey}):`, err.message);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
