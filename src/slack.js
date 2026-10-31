'use strict';

const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
// User token (xoxp-) needed for search.messages — bot tokens cannot search.
// Required user scope: search:read.
const userClient = new WebClient(process.env.SLACK_USER_TOKEN);

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
 * @param {string} text - also the notification/fallback text when `blocks` is set
 * @param {{notify?: boolean, blocks?: object[]}} [opts] - notify=false suppresses
 *   the "✅ Replied in Slack" preview, for callers that emit their own single
 *   summary instead. The DRY_RUN preview is always emitted — it's the only output
 *   in that mode. `blocks` renders interactive Block Kit content (e.g. the
 *   "Review again" button); `text` stays as the fallback.
 */
async function replyToThread(channel, ts, text, opts = {}) {
  const { notify = true, blocks } = opts;
  const threadLink = buildThreadLink(channel, ts);
  const location = threadLink ?? `Channel: \`${channel}\` Thread: \`${ts}\``;

  if (process.env.DRY_RUN === 'true') {
    await preview(`👉 *Please reply in Slack*\nThread: ${location}\nMessage: ${text}`);
    return;
  }

  if (notify) {
    await preview(`✅ *Replied in Slack*\nThread: ${location}\nMessage: ${text}`);
  }

  try {
    await slack.chat.postMessage({ channel, thread_ts: ts, text, ...(blocks ? { blocks } : {}) });
    console.log(`[Slack] Replied to thread ${ts} in ${channel}`);
  } catch (err) {
    console.log(`[Slack] replyToThread(${channel}, ${ts}) failed:`, err.message);
  }
}

/**
 * Posts a plain message (optionally as a thread reply) and returns its ts. A
 * real post — unlike `replyToThread` it ignores DRY_RUN and emits no preview —
 * meant for my own private channels, where the message *is* the output.
 * Never throws.
 *
 * @param {string} channel
 * @param {string} text
 * @param {{threadTs?: string, blocks?: object[]}} [opts] - `blocks` (Block Kit)
 *   renders instead of `text`, which stays as the notification fallback
 * @returns {Promise<string|null>} the new message's ts, null when the post failed
 */
async function postToChannel(channel, text, { threadTs, blocks } = {}) {
  try {
    const res = await slack.chat.postMessage({
      channel,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return res?.ts ?? null;
  } catch (err) {
    console.log(`[Slack] postToChannel(${channel}) failed:`, err.message);
    return null;
  }
}

/**
 * All messages of a thread, root first (`conversations.replies`).
 *
 * @param {string} channel
 * @param {string} threadTs - the root message's ts
 * @returns {Promise<object[]>} empty when the call failed
 */
async function fetchThreadMessages(channel, threadTs) {
  try {
    const res = await slack.conversations.replies({ channel, ts: threadTs, limit: 1000 });
    return res.messages || [];
  } catch (err) {
    console.log(`[Slack] fetchThreadMessages(${channel}, ${threadTs}) failed:`, err.message);
    return [];
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
 * Fetches one thread reply by its own timestamp. `fetchMessage` can't do this —
 * `conversations.history` only lists top-level messages, so for a reply it
 * returns the nearest root instead. `conversations.replies` accepts a reply's
 * ts; the result is matched on `ts` so a thread listing starting at the root
 * can't be mistaken for the reply.
 *
 * @param {string} channel
 * @param {string} ts - the reply's own timestamp
 * @returns {Promise<object|null>} null when not found or the call failed
 */
async function fetchThreadReply(channel, ts) {
  try {
    const result = await slack.conversations.replies({ channel, ts, limit: 1000 });
    return (result.messages || []).find(m => m.ts === ts) ?? null;
  } catch (err) {
    console.log(`[Slack] fetchThreadReply(${channel}, ${ts}) failed:`, err.message);
    return null;
  }
}

/**
 * Searches all of the user's accessible Slack content (public + private channels,
 * DMs, group DMs) using the user-token search.messages API. Paginates internally.
 *
 * Each match has shape: { text, ts, user, channel: { id, name, is_private, is_im, ... } }
 *
 * @param {string} query - Slack search modifier string, e.g. "from:<@U123> on:2026-05-09"
 * @returns {Promise<Array<object>>}
 */
async function searchMyMessages(query) {
  const matches = [];
  let page = 1;
  let totalPages = 1;
  try {
    do {
      const res = await userClient.search.messages({
        query,
        count: 100,
        sort: 'timestamp',
        sort_dir: 'desc',
        page,
      });
      const got = res.messages?.matches || [];
      matches.push(...got);
      totalPages = res.messages?.paging?.pages || 1;
      page++;
    } while (page <= totalPages && page <= 50); // safety cap: 50 pages × 100 = 5000 messages
  } catch (err) {
    console.log('[Slack] searchMyMessages failed:', err.message);
  }
  return matches;
}

/**
 * Posts a preview message to terminal and SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE (if configured).
 * Always runs regardless of DRY_RUN, so you can audit actions before/while they execute.
 *
 * @param {string} text
 */
async function preview(text, opts = {}) {
  const { tag = true } = opts;
  const userId = process.env.MY_SLACK_USER_ID;
  const finalText = tag && userId ? `${text}\n<@${userId}>` : text;

  console.log(`[PREVIEW] ${finalText}`);

  const channel = process.env.SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE;
  if (!channel) return;

  try {
    await slack.chat.postMessage({ channel, text: finalText });
  } catch (err) {
    console.log(`[PREVIEW] post failed:`, err.message);
  }
}

/**
 * Adds an emoji reaction to a Slack message — used to mark the original message
 * (the one with the PR link) once the bot approves that PR on GitHub.
 * Bot must have the reactions:write scope.
 *
 * @param {string} channel
 * @param {string} ts - message timestamp in dot format
 * @param {string} emoji - reaction name without colons, e.g. 'white_check_mark'
 * @returns {Promise<{ok: boolean, error?: string}>} ok=true once Slack accepted
 *   it (or it was already there) — callers use this to surface a failure
 *   instead of it silently vanishing into server logs no one is watching.
 */
async function reactToMessage(channel, ts, emoji) {
  if (process.env.DRY_RUN === 'true') {
    await preview(`👉 *Please react :${emoji}: to this message*\nChannel: \`${channel}\` Thread: \`${ts}\``);
    return { ok: true };
  }

  try {
    await slack.reactions.add({ channel, timestamp: ts, name: emoji });
    console.log(`[Slack] Reacted :${emoji}: to ${ts} in ${channel}`);
    return { ok: true };
  } catch (err) {
    // Someone (or a prior run) already put this reaction there — not worth surfacing.
    if (err.data?.error === 'already_reacted') return { ok: true };
    console.log(`[Slack] reactToMessage(${channel}, ${ts}, ${emoji}) failed:`, err.message);
    return { ok: false, error: err.data?.error || err.message };
  }
}

/**
 * Deletes the bot's own messages — top-level and thread replies — in a channel — used by `/clear-history`
 * to empty SLACK_BOT_PRIVATE_CHANNEL_REVIEW_CODE. `day` (YYYY-MM-DD, Asia/Bangkok) limits it to
 * that day; null clears everything. Messages not posted by a bot are skipped
 * (Slack would refuse them anyway). Paginates conversations.history, and conversations.replies for threads.
 *
 * @returns {Promise<{deleted: number, failed: number}>}
 */
async function clearChannelHistory(channel, day) {
  const range = {};
  if (day) {
    range.oldest = String(new Date(`${day}T00:00:00+07:00`).getTime() / 1000);
    range.latest = String(new Date(`${day}T23:59:59.999+07:00`).getTime() / 1000);
    range.inclusive = true;
  }

  const roots = [];
  let cursor;
  try {
    do {
      const res = await slack.conversations.history({ channel, limit: 200, cursor, ...range });
      roots.push(...(res.messages || []));
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (err) {
    console.log(`[Slack] clearChannelHistory(${channel}) history failed:`, err.message);
  }

  // Thread replies first, then the roots they hang off.
  const timestamps = [];
  for (const root of roots) {
    if (root.reply_count > 0) {
      let replyCursor;
      try {
        do {
          const res = await slack.conversations.replies({ channel, ts: root.ts, limit: 200, cursor: replyCursor });
          for (const m of res.messages || []) {
            if (m.ts !== root.ts && m.bot_id) timestamps.push(m.ts);
          }
          replyCursor = res.response_metadata?.next_cursor || undefined;
        } while (replyCursor);
      } catch (err) {
        console.log(`[Slack] clearChannelHistory(${channel}) replies of ${root.ts} failed:`, err.message);
      }
    }
  }
  for (const root of roots) {
    if (root.bot_id) timestamps.push(root.ts);
  }

  let deleted = 0;
  let failed = 0;
  for (const ts of timestamps) {
    const result = await deleteMessage(channel, ts);
    if (result.ok) deleted++;
    else failed++;
  }
  return { deleted, failed };
}

/**
 * Deletes a message the bot posted — used to clean up the "Starting code
 * review..." status message once the review completes. Bot must have
 * chat:write scope; Slack only allows deleting messages the bot itself sent.
 * Respects DRY_RUN the same way `replyToThread`/`reactToMessage` do: previewed
 * instead of deleted for real.
 *
 * @param {string} channel
 * @param {string} ts - message timestamp in dot format
 * @param {{ignoreDryRun?: boolean}} [opts] - delete for real even under DRY_RUN,
 *   for my own private channels where `postToChannel` also posts for real
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function deleteMessage(channel, ts, { ignoreDryRun = false } = {}) {
  if (process.env.DRY_RUN === 'true' && !ignoreDryRun) {
    await preview(`👉 *Please delete this message*\nChannel: \`${channel}\` Thread: \`${ts}\``);
    return { ok: true };
  }

  try {
    await slack.chat.delete({ channel, ts });
    console.log(`[Slack] Deleted message ${ts} in ${channel}`);
    return { ok: true };
  } catch (err) {
    console.log(`[Slack] deleteMessage(${channel}, ${ts}) failed:`, err.message);
    return { ok: false, error: err.data?.error || err.message };
  }
}

/**
 * Deletes a whole thread — every reply, then the root — for real (ignores
 * DRY_RUN; meant for my own private channels). The bot's own messages go
 * through the bot token; anyone else's (my hints) need the user token, which
 * only works with the `chat:write` user scope. Best-effort: a message that
 * can't be deleted is counted, not thrown.
 *
 * @param {string} channel
 * @param {string} threadTs - the root message's ts
 * @returns {Promise<{deleted: number, failed: number}>}
 */
async function deleteThread(channel, threadTs) {
  const messages = await fetchThreadMessages(channel, threadTs);
  // Root last, so a half-finished sweep still leaves a thread to retry from.
  const ordered = [...messages.filter(m => m.ts !== threadTs), ...messages.filter(m => m.ts === threadTs)];
  if (!ordered.length) ordered.push({ ts: threadTs, bot_id: 'unknown' });

  let deleted = 0;
  let failed = 0;
  for (const m of ordered) {
    try {
      await (m.bot_id ? slack : userClient).chat.delete({ channel, ts: m.ts });
      deleted++;
    } catch (err) {
      failed++;
      console.log(`[Slack] deleteThread(${channel}) couldn't delete ${m.ts}:`, err.data?.error || err.message);
    }
  }
  return { deleted, failed };
}

/**
 * Sweeps a thread and deletes every "Starting code review for PR #<n>..."
 * message it finds, not just one — a thread can carry more than one if the PR
 * was reviewed multiple times (e.g. via the "Review again" button), a run
 * crashed before it ever got to clean up after itself, or messages predate
 * this cleanup existing at all. Matches on the exact bot-generated text.
 * Best-effort: a failed fetch or an individual delete failure is logged, not
 * thrown.
 *
 * @param {string} channel
 * @param {string} threadTs
 * @param {string} [prNumber] - scope deletion to just this PR's starting
 *   message (another PR's starting message in the same thread — a message can
 *   link several — is then left alone). Omit to match any PR number, e.g. for
 *   a manual whole-thread cleanup.
 * @returns {Promise<number>} how many messages were actually deleted
 */
async function deleteStartingReviewMessages(channel, threadTs, prNumber) {
  const pattern = prNumber
    ? new RegExp(`^Starting code review for PR #${prNumber}\\. Will post results here shortly\\.$`)
    // Whole-thread sweep: a cancelled run leaves its "❌ Review of PR #<n>
    // cancelled by <@user>." notice behind too, so that goes with it.
    : /^(Starting code review for PR #\d+\. Will post results here shortly\.|(?:❌|:x:) Review of PR #\d+ cancelled by <@[A-Z0-9]+(?:\|[^>]*)?>\.)$/;

  let messages;
  try {
    const res = await slack.conversations.replies({ channel, ts: threadTs, limit: 1000 });
    messages = res.messages || [];
  } catch (err) {
    console.log(`[Slack] deleteStartingReviewMessages(${channel}, ${threadTs}) failed to fetch replies:`, err.message);
    return 0;
  }

  const targets = messages.filter(m => pattern.test(m.text || ''));
  let deleted = 0;
  for (const m of targets) {
    const result = await deleteMessage(channel, m.ts);
    if (result.ok) deleted++;
  }
  return deleted;
}

/**
 * Posts an ephemeral reply to a Slack interaction's `response_url` — visible only
 * to the person who clicked, and never added to the thread. Used to tell a
 * teammate why their "Review again" click didn't start a run.
 *
 * @param {string} responseUrl - payload.response_url from the interaction
 * @param {string} text
 * @returns {Promise<boolean>} true when Slack accepted it
 */
async function respondEphemeral(responseUrl, text) {
  if (!responseUrl) return false;
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
    if (!res.ok) {
      console.log(`[Slack] respondEphemeral failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log('[Slack] respondEphemeral error:', err.message);
    return false;
  }
}

/**
 * Replaces the message a Block Kit button lives on, via the interaction's
 * `response_url` — used to swap a completion reply's buttons for a final status
 * line once someone has acted on it, so the buttons can't be pressed twice.
 * Without `blocks` the old ones are dropped (text only); pass `blocks` to keep
 * rich formatting, since plain `text` collapses line breaks into one paragraph.
 *
 * @param {string} responseUrl - payload.response_url from the interaction
 * @param {string} text - the full replacement message (also the notification fallback)
 * @param {{blocks?: object[]}} [opts]
 * @returns {Promise<boolean>} true when Slack accepted it (response_urls expire after 30 min)
 */
async function replaceOriginal(responseUrl, text, { blocks } = {}) {
  if (!responseUrl) return false;
  try {
    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text, ...(blocks ? { blocks } : {}) }),
    });
    if (!res.ok) {
      console.log(`[Slack] replaceOriginal failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log('[Slack] replaceOriginal error:', err.message);
    return false;
  }
}

module.exports = {
  replyToThread,
  fetchMessage,
  fetchThreadReply,
  preview,
  reactToMessage,
  deleteMessage,
  clearChannelHistory,
  deleteStartingReviewMessages,
  deleteThread,
  searchMyMessages,
  buildThreadLink,
  respondEphemeral,
  postToChannel,
  fetchThreadMessages,
  replaceOriginal,
};
