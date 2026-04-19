'use strict';

const { Version2Client } = require('jira.js');
const { preview } = require('./slack');

const TRANSITION_NAMES = {
  [process.env.ID_TO_DO]:       'To Do',
  [process.env.ID_IN_PROGRESS]: 'In Progress',
  [process.env.ID_IN_REVIEW]:   'In Review',
  [process.env.ID_QA_READY]:    'QA Ready',
  [process.env.ID_QA_FAILED]:   'QA Failed',
  [process.env.ID_IN_TEST]:     'In Test',
  [process.env.ID_QA_SUCCESS]:  'QA Success',
  [process.env.ID_WILL_NOT_FIX]:'Will Not Fix',
};

// Defines which status the ticket must currently be in before transitioning.
// Evaluated lazily so env vars are read at call time, not module load time.
function requiredCurrentStatus(transitionId) {
  if (transitionId === process.env.ID_IN_PROGRESS) return 'To Do';
  if (transitionId === process.env.ID_IN_REVIEW)   return 'In Progress';
  if (transitionId === process.env.ID_QA_READY)    return 'In Review';
  return null; // no restriction for other transitions
}

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
  if (!transitionId) return false;

  const required = requiredCurrentStatus(transitionId);
  const issue = await client.issues.getIssue({ issueIdOrKey: issueKey });
  const currentStatus = issue.fields.status.name;

  if (required && currentStatus !== required) {
    console.log(`[Jira] Skipping ${issueKey}: status is "${currentStatus}", expected "${required}"`);
    return false;
  }

  // Block "To Do → In Progress" for tickets in the backlog sprint (id 249)
  if (transitionId === process.env.ID_IN_PROGRESS) {
    const sprints = issue.fields.customfield_10010 || [];
    const inBacklog = sprints.some(s => s.id === 249);
    if (inBacklog) {
      console.log(`[Jira] Skipping ${issueKey}: ticket is in Active Sprint Backlog (249)`);
      return false;
    }
  }

  const statusName = TRANSITION_NAMES[transitionId] || `id ${transitionId}`;

  if (process.env.DRY_RUN === 'true') {
    await preview(`🔔 *[PREVIEW] Jira transition*\nTicket: *${issueKey}*\nAction: *${currentStatus}* → *${statusName}*`);
    return true;
  }
  try {
    await client.issues.doTransition({
      issueIdOrKey: issueKey,
      transition: { id: transitionId },
    });
    console.log(`[Jira] Transitioned ${issueKey} → ${statusName}`);
    return true;
  } catch (err) {
    console.error(`[Jira] transitionIssue(${issueKey}, ${transitionId}) failed:`, err.message);
    return false;
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
    await preview(`🔔 *[PREVIEW] Jira comment*\nTicket: *${issueKey}*\nComment: ${text}`);
    return;
  }
  try {
    await client.issueComments.addComment({
      issueIdOrKey: issueKey,
      comment: text,
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
