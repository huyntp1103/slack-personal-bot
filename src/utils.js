'use strict';

/**
 * Extracts the first Jira issue key from a string (e.g. PR title).
 * @param {string} text
 * @returns {string|null}
 */
function extractJiraKey(text) {
  const match = text.match(/[A-Z]+-\d+/);
  return match ? match[0] : null;
}

/**
 * Extracts every Jira issue key from a string, deduplicated, in first-occurrence order.
 * @param {string} text
 * @returns {string[]}
 */
function extractAllJiraKeys(text) {
  if (!text) return [];
  const matches = text.match(/[A-Z]+-\d+/g) || [];
  return [...new Set(matches)];
}

/**
 * Extracts Slack channel ID and thread timestamp from a Jira issue description.
 * Works on both ADF objects and plain text by stringifying first.
 * Slack archive URLs encode the timestamp as a digit string with the decimal removed:
 *   /archives/C0ABC1234/p1712345678901234  →  ts = "1712345678.901234"
 *
 * @param {object|string} description - Jira issue description (ADF or plain string)
 * @returns {{ channel: string, ts: string }|null}
 */
function extractSlackThread(description) {
  if (!description) return null;

  const text = typeof description === 'string' ? description : JSON.stringify(description);
  const match = text.match(/archives\/([A-Z0-9]+)\/p(\d+)/i);

  if (!match) return null;

  const channel = match[1];
  const raw = match[2];
  const ts = `${raw.slice(0, 10)}.${raw.slice(10)}`;

  return { channel, ts };
}

// owner/repo/number of a GitHub PR link, with or without scheme or `www.` — people
// paste `github.com/org/repo/pull/1` bare, and Slack auto-links it as `http://`.
// The lookbehind stops `notgithub.com/...` from matching.
const GITHUB_PR_RE = /(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s|<>]+)\/([^/\s|<>]+)\/pull\/(\d+)/gi;

// An unfurl attachment only counts through the URL it unfurled. Its body text is
// the linked page's own content (a PR description that mentions "other-repo#123"
// is context, not a PR the author asked anyone to review), so it is never read.
const ATTACHMENT_LINK_KEYS = new Set(['from_url', 'original_url', 'title_link']);

/**
 * Slack mrkdwn → the text a reader would type, with every hyperlink reduced to
 * its *target*: `<https://real|visible label>` becomes `https://real`. The label
 * is whatever the author chose to display and can say anything (even name a
 * different PR than the one it points at), so it is never read.
 */
function stripLinkLabels(text) {
  return String(text).replace(/<([^>|]+)(?:\|[^>]*)?>/g, ' $1 ');
}

/**
 * Collects candidate strings from rich-text blocks: a `link` element contributes
 * only its `url` (never its display `text`); every other `text`/`url` string is
 * what the author typed or attached and is collected as-is.
 */
function collectBlockStrings(node, out) {
  if (Array.isArray(node)) {
    node.forEach(child => collectBlockStrings(child, out));
  } else if (node && typeof node === 'object') {
    if (node.type === 'link') {
      if (typeof node.url === 'string') out.push(node.url);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (key === 'url' || key === 'text') out.push(value);
      } else {
        collectBlockStrings(value, out);
      }
    }
  }
}

function collectAttachmentUrls(attachments, out) {
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    for (const key of ATTACHMENT_LINK_KEYS) {
      if (typeof attachment?.[key] === 'string') out.push(attachment[key]);
    }
  }
}

/**
 * Extracts every GitHub PR link from a Slack message, normalised to
 * `https://github.com/<owner>/<repo>/pull/<n>`, deduplicated, in first-occurrence order.
 *
 * It reads the **actual link targets**, not their display text:
 * - `text`: `<url|label>` → `url` (label discarded); text typed outside a hyperlink
 *   is still matched, including bare `github.com/...` with no scheme.
 * - rich-text `blocks`: a `link` element's `url` only — its visible label is ignored,
 *   so `PR: github.com/x/y/pull/1` linked to `.../pull/2` yields PR 2, not both.
 * - `attachments`: the unfurled URL fields only, never an attachment's body text.
 *
 * @param {string|{text?: string, blocks?: any[], attachments?: any[]}|null} message
 * @returns {string[]}
 */
function extractPrUrls(message) {
  const sources = [];
  if (typeof message === 'string') {
    sources.push(message);
  } else if (message) {
    sources.push(message.text || '');
    collectBlockStrings(message.blocks, sources);
    collectAttachmentUrls(message.attachments, sources);
  }

  const urls = new Set();
  for (const source of sources) {
    for (const [, owner, repo, number] of stripLinkLabels(source).matchAll(GITHUB_PR_RE)) {
      urls.add(`https://github.com/${owner}/${repo}/pull/${number}`);
    }
  }
  return [...urls];
}

module.exports = { extractJiraKey, extractAllJiraKeys, extractSlackThread, extractPrUrls };
