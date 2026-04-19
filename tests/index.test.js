'use strict';

jest.mock('../src/jira', () => ({
  transitionIssue: jest.fn(),
  addComment: jest.fn(),
  getIssue: jest.fn(),
}));
jest.mock('../src/slack', () => ({
  replyToThread: jest.fn(),
  fetchMessage: jest.fn(),
  preview: jest.fn(),
}));
jest.mock('../src/github', () => ({
  fetchPrData: jest.fn(),
  fetchPrTitle: jest.fn(),
}));

const { transitionIssue, addComment, getIssue } = require('../src/jira');
const { fetchMessage } = require('../src/slack');
const { fetchPrData, fetchPrTitle } = require('../src/github');

process.env.MY_SLACK_USER_ID = 'U093ZDNQJF3';
process.env.SLACK_REVIEW_CHANNEL = 'C05F65TBB9P';
process.env.ID_IN_REVIEW = '41';
process.env.ID_QA_READY = '51';
process.env.SLACK_SIGNING_SECRET = '';

const request = require('supertest');
const app = require('../src/index');

beforeEach(() => {
  jest.clearAllMocks();
  transitionIssue.mockResolvedValue(true);
  addComment.mockResolvedValue(undefined);
  getIssue.mockResolvedValue({ fields: { issuetype: { name: 'Task' }, description: null } });
  fetchPrTitle.mockResolvedValue('feat: UP-69726 some feature');
  fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 some feature', baseBranch: 'develop' });
  fetchMessage.mockResolvedValue({
    text: '<https://github.com/Everfit-io/everfit-api/pull/16391>',
  });
});

// ─── url_verification ─────────────────────────────────────────────────────────

describe('POST /slack/events — url_verification', () => {
  test('responds with challenge', async () => {
    const res = await request(app)
      .post('/slack/events')
      .send({ type: 'url_verification', challenge: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('abc123');
  });
});

// ─── handleReviewMessage ──────────────────────────────────────────────────────

function reviewMessagePayload(overrides = {}) {
  return {
    type: 'event_callback',
    event: {
      type: 'message',
      user: 'U093ZDNQJF3',
      channel: 'C05F65TBB9P',
      text: '<https://github.com/Everfit-io/everfit-api/pull/16391>',
      ts: '1712345678.901234',
      ...overrides,
    },
  };
}

describe('handleReviewMessage', () => {
  test('transitions to In Review when valid message', async () => {
    await request(app).post('/slack/events').send(reviewMessagePayload());
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '41');
  });

  test('ignores messages from other users', async () => {
    await request(app).post('/slack/events').send(reviewMessagePayload({ user: 'UOTHER' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores messages from other channels', async () => {
    await request(app).post('/slack/events').send(reviewMessagePayload({ channel: 'COTHER' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores thread replies', async () => {
    await request(app).post('/slack/events').send(
      reviewMessagePayload({ ts: '111.222', thread_ts: '111.000' })
    );
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores messages without a GitHub PR link', async () => {
    await request(app).post('/slack/events').send(
      reviewMessagePayload({ text: 'just a regular message' })
    );
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('extracts Jira key from PR title when not in message text', async () => {
    fetchPrTitle.mockResolvedValue('feat: UP-99999 some feature');
    await request(app).post('/slack/events').send(
      reviewMessagePayload({ text: '<https://github.com/Everfit-io/everfit-api/pull/16391>' })
    );
    expect(transitionIssue).toHaveBeenCalledWith('UP-99999', '41');
  });
});

// ─── handleReactionAdded ──────────────────────────────────────────────────────

function reactionPayload(overrides = {}) {
  return {
    type: 'event_callback',
    event: {
      type: 'reaction_added',
      user: 'U093ZDNQJF3',
      reaction: 'white_check_mark',
      item: {
        type: 'message',
        channel: 'C05F65TBB9P',
        ts: '1712345678.901234',
      },
      ...overrides,
    },
  };
}

describe('handleReactionAdded', () => {
  test('transitions to QA Ready and adds comment', async () => {
    await request(app).post('/slack/events').send(reactionPayload());
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '51');
    expect(addComment).toHaveBeenCalled();
  });

  test('ignores reactions from other users', async () => {
    await request(app).post('/slack/events').send(reactionPayload({ user: 'UOTHER' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores non-checkmark reactions', async () => {
    await request(app).post('/slack/events').send(reactionPayload({ reaction: 'thumbsup' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips if base branch is not develop', async () => {
    fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 feature', baseBranch: 'main' });
    await request(app).post('/slack/events').send(reactionPayload());
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips comment and Slack reply if transition returns false', async () => {
    transitionIssue.mockResolvedValue(false);
    await request(app).post('/slack/events').send(reactionPayload());
    expect(addComment).not.toHaveBeenCalled();
  });

  test('replies to Slack thread for Bug tickets', async () => {
    const { replyToThread } = require('../src/slack');
    replyToThread.mockResolvedValue(undefined);
    getIssue.mockResolvedValue({
      fields: {
        issuetype: { name: 'Bug' },
        description: 'https://workspace.slack.com/archives/C0ABC1234/p1712345678901234',
      },
    });
    await request(app).post('/slack/events').send(reactionPayload());
    expect(replyToThread).toHaveBeenCalledWith('C0ABC1234', '1712345678.901234', expect.any(String));
  });

  test('skips Slack reply for non-Bug tickets', async () => {
    const { replyToThread } = require('../src/slack');
    getIssue.mockResolvedValue({
      fields: { issuetype: { name: 'Story' }, description: null },
    });
    await request(app).post('/slack/events').send(reactionPayload());
    expect(replyToThread).not.toHaveBeenCalled();
  });
});

// ─── POST /git/push ───────────────────────────────────────────────────────────

describe('POST /git/push', () => {
  test('transitions to In Progress', async () => {
    await request(app)
      .post('/git/push')
      .send({ jiraKey: 'UP-69726' });
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', process.env.ID_IN_PROGRESS);
  });

  test('ignores requests with no jiraKey', async () => {
    await request(app).post('/git/push').send({});
    expect(transitionIssue).not.toHaveBeenCalled();
  });
});
