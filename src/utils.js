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

module.exports = { extractJiraKey, extractSlackThread };
