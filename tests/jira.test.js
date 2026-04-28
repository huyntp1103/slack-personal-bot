'use strict';

// Must mock dependencies before requiring jira.js
jest.mock('jira.js');
jest.mock('../src/slack', () => ({ preview: jest.fn() }));

const { Version2Client } = require('jira.js');

const mockGetIssue = jest.fn();
const mockDoTransition = jest.fn();
const mockAddComment = jest.fn();

Version2Client.mockImplementation(() => ({
  issues: { getIssue: mockGetIssue, doTransition: mockDoTransition },
  issueComments: { addComment: mockAddComment },
}));

// Set env vars before requiring jira.js so the module-level client is initialised
process.env.JIRA_HOST = 'https://everfit.atlassian.net';
process.env.JIRA_EMAIL = 'test@test.com';
process.env.JIRA_TOKEN = 'token';
process.env.ID_IN_PROGRESS = '21';
process.env.ID_IN_REVIEW = '41';
process.env.ID_QA_READY = '51';

const { transitionIssue, addComment } = require('../src/jira');

function mockIssue({ status = 'To Do', sprints = [], issueType = 'Task' } = {}) {
  mockGetIssue.mockResolvedValue({
    fields: {
      status: { name: status },
      customfield_10010: sprints,
      issuetype: { name: issueType },
      description: null,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDoTransition.mockResolvedValue({});
  mockAddComment.mockResolvedValue({});
});

describe('transitionIssue — status guard', () => {
  test('transitions when current status matches required', async () => {
    mockIssue({ status: 'To Do' });
    const result = await transitionIssue('UP-1', '21');
    expect(mockDoTransition).toHaveBeenCalledWith({ issueIdOrKey: 'UP-1', transition: { id: '21' } });
    expect(result).toBe(true);
  });

  test('skips when current status does not match required', async () => {
    mockIssue({ status: 'In Review' });
    const result = await transitionIssue('UP-1', '21'); // In Progress requires To Do
    expect(mockDoTransition).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test('skips In Review transition when status is not In Progress', async () => {
    mockIssue({ status: 'To Do' });
    const result = await transitionIssue('UP-1', '41');
    expect(mockDoTransition).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test('skips QA Ready transition when status is not In Review', async () => {
    mockIssue({ status: 'In Progress' });
    const result = await transitionIssue('UP-1', '51');
    expect(mockDoTransition).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test('returns false when no transitionId', async () => {
    const result = await transitionIssue('UP-1', undefined);
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });
});

describe('transitionIssue — backlog sprint guard', () => {
  test('skips In Progress transition if ticket is in sprint 249', async () => {
    mockIssue({ status: 'To Do', sprints: [{ id: 249, name: 'Active Sprint Backlog' }] });
    const result = await transitionIssue('UP-1', '21');
    expect(mockDoTransition).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  test('proceeds if ticket is in a different sprint', async () => {
    mockIssue({ status: 'To Do', sprints: [{ id: 4667, name: 'Sprint 8-26' }] });
    const result = await transitionIssue('UP-1', '21');
    expect(mockDoTransition).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  test('proceeds if ticket has no sprint', async () => {
    mockIssue({ status: 'To Do', sprints: [] });
    const result = await transitionIssue('UP-1', '21');
    expect(mockDoTransition).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

describe('transitionIssue — API failure', () => {
  test('returns false when doTransition throws', async () => {
    mockIssue({ status: 'To Do' });
    mockDoTransition.mockRejectedValue(new Error('API error'));
    const result = await transitionIssue('UP-1', '21');
    expect(result).toBe(false);
  });
});

describe('addComment', () => {
  test('calls addComment API with correct params', async () => {
    await addComment('UP-1', 'Ready for QA testing');
    expect(mockAddComment).toHaveBeenCalledWith({
      issueIdOrKey: 'UP-1',
      comment: 'Ready for QA testing',
    });
  });

});
