'use strict';

const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

/**
 * Builds a clickable Slack archive URL for a given channel + thread ts.
 * Returns null if SLACK_WORKSPACE env var is not set.
 *
 * Slack archive URL format: https://<workspace>.slack.com/archives/<channel>/p<ts-without-dot>
 * e.g. ts "1712345678.901234" → "p1712345678901234"
 */
function buildThreadLink(channel, ts) {
  const workspace = process.env.SLACK_WORKSPACE;
  if (!workspace || !channel || !ts) return null;
  return `https://${workspace}.slack.com/archives/${channel}/p${String(ts).replace('.', '')}`;
}

/**
 * Replies to an existing Slack thread.
 * Bot must have chat:write or chat:write.public scope.
 *
 * @param {string} channel - Slack channel ID
 * @param {string} ts - Thread timestamp in dot format (e.g. 1712345678.901234)
 * @param {string} text
 */
async function replyToThread(channel, ts, text) {
  const threadLink = buildThreadLink(channel, ts);
  const location = threadLink ?? `Channel: \`${channel}\` Thread: \`${ts}\``;

  if (process.env.DRY_RUN === 'true') {
    await preview(`👉 *Please reply in Slack*\nThread: ${location}\nMessage: ${text}`);
    return;
  }

  await preview(`✅ *Replied in Slack*\nThread: ${location}\nMessage: ${text}`);

  try {
    await slack.chat.postMessage({ channel, thread_ts: ts, text });
    console.log(`[Slack] Replied to thread ${ts} in ${channel}`);
  } catch (err) {
    console.log(`[Slack] replyToThread(${channel}, ${ts}) failed:`, err.message);
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
    console.log(`[Slack] fetchMessage(${channel}, ${ts}) failed:`, err.message);
    return null;
  }
}

/**
 * Posts a preview message to terminal and SLACK_PREVIEW_CHANNEL (if configured).
 * Always runs regardless of DRY_RUN, so you can audit actions before/while they execute.
 *
 * @param {string} text
 */
async function preview(text) {
  console.log(`[PREVIEW] ${text}`);

  const channel = process.env.SLACK_PREVIEW_CHANNEL;
  if (!channel) return;

  try {
    await slack.chat.postMessage({ channel, text });
  } catch (err) {
    console.log(`[PREVIEW] post failed:`, err.message);
  }
}

module.exports = { replyToThread, fetchMessage, preview };
