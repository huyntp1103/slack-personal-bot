'use strict';

const { Version2Client } = require('jira.js');

const client = new Version2Client({
  host: process.env.JIRA_HOST,
  authentication: {
    basic: {
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_TOKEN,
    },
  },
});

/**
 * Transitions a Jira issue to a new status.
 * Swallows errors silently — already-transitioned tickets return 400 and that's fine.
 *
 * @param {string} issueKey
 * @param {string} transitionId
 */
async function transitionIssue(issueKey, transitionId) {
  if (!transitionId) return;
  if (process.env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] Would transition ${issueKey} → transition id ${transitionId}`);
    return;
  }
  try {
    await client.issues.doTransition({
      issueIdOrKey: issueKey,
      transition: { id: transitionId },
    });
    console.log(`[Jira] Transitioned ${issueKey} → transition ${transitionId}`);
  } catch (err) {
    console.error(`[Jira] transitionIssue(${issueKey}, ${transitionId}) failed:`, err.message);
  }
}

/**
 * Adds a plain-text comment to a Jira issue using ADF format.
 *
 * @param {string} issueKey
 * @param {string} text
 */
async function addComment(issueKey, text) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`[DRY RUN] Would add comment to ${issueKey}: "${text}"`);
    return;
  }
  try {
    await client.issueComments.addComment({
      issueIdOrKey: issueKey,
      requestBody: {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text }],
            },
          ],
        },
      },
    });
    console.log(`[Jira] Comment added to ${issueKey}`);
  } catch (err) {
    console.error(`[Jira] addComment(${issueKey}) failed:`, err.message);
  }
}

/**
 * Fetches a Jira issue with all fields.
 *
 * @param {string} issueKey
 * @returns {Promise<object>}
 */
async function getIssue(issueKey) {
  return client.issues.getIssue({ issueIdOrKey: issueKey });
}

module.exports = { transitionIssue, addComment, getIssue };
