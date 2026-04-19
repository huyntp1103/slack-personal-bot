'use strict';

const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Replies to an existing Slack thread.
 * Bot must have chat:write or chat:write.public scope.
 *
 * @param {string} channel - Slack channel ID
 * @param {string} ts - Thread timestamp in dot format (e.g. 1712345678.901234)
 * @param {string} text
 */
async function replyToThread(channel, ts, text) {
  if (process.env.DRY_RUN === 'true') {
    await preview(`🔔 *[PREVIEW] Slack thread reply*\nChannel: \`${channel}\` Thread: \`${ts}\`\nMessage: ${text}`);
    return;
  }
  try {
    await slack.chat.postMessage({ channel, thread_ts: ts, text });
    console.log(`[Slack] Replied to thread ${ts} in ${channel}`);
  } catch (err) {
    console.error(`[Slack] replyToThread(${channel}, ${ts}) failed:`, err.message);
  }
}

/**
 * Fetches a single message by channel + timestamp.
 * Requires channels:history scope.
 *
 * @param {string} channel
 * @param {string} ts
 * @returns {Promise<object|null>}
 */
async function fetchMessage(channel, ts) {
  try {
    const result = await slack.conversations.history({
      channel,
      latest: ts,
      limit: 1,
      inclusive: true,
    });
    return result.messages?.[0] ?? null;
  } catch (err) {
    console.error(`[Slack] fetchMessage(${channel}, ${ts}) failed:`, err.message);
    return null;
  }
}

/**
 * Posts a dry-run preview message to SLACK_PREVIEW_CHANNEL.
 * Only active when DRY_RUN=true.
 *
 * @param {string} text
 */
async function preview(text) {
  const channel = process.env.SLACK_PREVIEW_CHANNEL;
  if (!channel) {
    console.log(`[DRY RUN] ${text}`);
    return;
  }
  try {
    await slack.chat.postMessage({ channel, text });
  } catch (err) {
    console.error(`[DRY RUN] preview post failed:`, err.message);
  }
}

module.exports = { replyToThread, fetchMessage, preview };
