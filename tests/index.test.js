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
  fetchPrCommits: jest.fn(),
}));

const { transitionIssue, addComment, getIssue } = require('../src/jira');
const { fetchMessage } = require('../src/slack');
const { fetchPrData, fetchPrTitle, fetchPrCommits } = require('../src/github');

process.env.MY_SLACK_USER_ID = 'U093ZDNQJF3';
process.env.SLACK_REVIEW_CHANNEL = 'C05F65TBB9P';
process.env.ID_IN_REVIEW = '41';
process.env.ID_QA_READY = '51';
process.env.SLACK_SIGNING_SECRET = '';
process.env.QA_NOTIFY_DELAY_MINUTES = '15';
process.env.MY_GITHUB_USERNAME = 'huynguyen-everfit';

const request = require('supertest');
const app = require('../src/index');

beforeEach(() => {
  jest.clearAllMocks();
  transitionIssue.mockResolvedValue(true);
  addComment.mockResolvedValue(undefined);
  getIssue.mockResolvedValue({ fields: { issuetype: { name: 'Task' }, description: null } });
  fetchPrTitle.mockResolvedValue('feat: UP-69726 some feature');
  fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 some feature', baseBranch: 'develop' });
  fetchPrCommits.mockResolvedValue([]);
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
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => jest.useRealTimers());

  // Helper: send reaction, advance all timers, flush pending microtasks
  async function sendReaction(payload = reactionPayload()) {
    await request(app).post('/slack/events').send(payload);
    await jest.runAllTimersAsync();
  }

  test('transitions to QA Ready immediately (before delay)', async () => {
    await request(app).post('/slack/events').send(reactionPayload());
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '51');
  });

  test('adds comment with DEV env after delay (develop base)', async () => {
    await sendReaction();
    expect(addComment).toHaveBeenCalledWith('UP-69726', 'Ready for QA testing on DEV');
  });

  test('ignores reactions from other users', async () => {
    await sendReaction(reactionPayload({ user: 'UOTHER' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores non-checkmark reactions', async () => {
    await sendReaction(reactionPayload({ reaction: 'thumbsup' }));
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips if base branch is not in allowlist', async () => {
    fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 feature', baseBranch: 'feature/foo' });
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('transitions for base branch main but does not comment or reply', async () => {
    const { replyToThread } = require('../src/slack');
    fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 feature', baseBranch: 'main' });
    await sendReaction();
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '51');
    expect(addComment).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });

  test('transitions for base branch master but does not comment or reply', async () => {
    fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 feature', baseBranch: 'master' });
    await sendReaction();
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '51');
    expect(addComment).not.toHaveBeenCalled();
  });

  test('releasing_staging: filters commits by my username, dedupes by Jira key, processes each ticket with STAGING env', async () => {
    fetchPrData.mockResolvedValue({ title: 'release', baseBranch: 'releasing_staging' });
    fetchPrCommits.mockResolvedValue([
      { message: 'feat: UP-100 thing', authorLogin: 'huynguyen-everfit' },
      { message: 'fix: UP-100 follow-up', authorLogin: 'huynguyen-everfit' }, // duplicate key
      { message: 'feat: UP-200 other', authorLogin: 'huynguyen-everfit' },
      { message: 'chore: UP-999 from teammate', authorLogin: 'someone-else' }, // filtered out
    ]);
    await sendReaction();
    expect(transitionIssue).toHaveBeenCalledWith('UP-100', '51');
    expect(transitionIssue).toHaveBeenCalledWith('UP-200', '51');
    expect(transitionIssue).not.toHaveBeenCalledWith('UP-999', '51');
    expect(transitionIssue).toHaveBeenCalledTimes(2);
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(addComment).toHaveBeenCalledWith('UP-100', 'Ready for QA testing on STAGING');
    expect(addComment).toHaveBeenCalledWith('UP-200', 'Ready for QA testing on STAGING');
  });

  test('releasing_staging: skips if no commits authored by me have a Jira key', async () => {
    fetchPrData.mockResolvedValue({ title: 'release', baseBranch: 'releasing_staging' });
    fetchPrCommits.mockResolvedValue([
      { message: 'chore: UP-1 from someone else', authorLogin: 'someone-else' },
    ]);
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips comment and Slack reply if transition returns false', async () => {
    transitionIssue.mockResolvedValue(false);
    await sendReaction();
    expect(addComment).not.toHaveBeenCalled();
  });

  test('replies to Slack thread for Bug tickets with DEV env (develop base)', async () => {
    const { replyToThread } = require('../src/slack');
    replyToThread.mockResolvedValue(undefined);
    getIssue.mockResolvedValue({
      fields: {
        issuetype: { name: 'Bug' },
        description: 'https://workspace.slack.com/archives/C0ABC1234/p1712345678901234',
      },
    });
    await sendReaction();
    expect(replyToThread).toHaveBeenCalledWith(
      'C0ABC1234',
      '1712345678.901234',
      'Dạ card này test được ở DEV rồi ạ'
    );
  });

  test('replies to Slack thread for Bug tickets with STAGING env (releasing_staging base)', async () => {
    const { replyToThread } = require('../src/slack');
    replyToThread.mockResolvedValue(undefined);
    fetchPrData.mockResolvedValue({ title: 'release', baseBranch: 'releasing_staging' });
    fetchPrCommits.mockResolvedValue([
      { message: 'feat: UP-100 thing', authorLogin: 'huynguyen-everfit' },
    ]);
    getIssue.mockResolvedValue({
      fields: {
        issuetype: { name: 'Bug' },
        description: 'https://workspace.slack.com/archives/C0ABC1234/p1712345678901234',
      },
    });
    await sendReaction();
    expect(replyToThread).toHaveBeenCalledWith(
      'C0ABC1234',
      '1712345678.901234',
      'Dạ card này test được ở STAGING rồi ạ'
    );
  });

  test('skips Slack reply for non-Bug tickets', async () => {
    const { replyToThread } = require('../src/slack');
    getIssue.mockResolvedValue({
      fields: { issuetype: { name: 'Story' }, description: null },
    });
    await sendReaction();
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
