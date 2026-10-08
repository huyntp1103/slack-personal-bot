'use strict';

jest.mock('../src/jira', () => ({
  transitionIssue: jest.fn(),
  addComment: jest.fn(),
  getIssue: jest.fn(),
  getIssueSummary: jest.fn(),
}));
jest.mock('../src/slack', () => ({
  replyToThread: jest.fn(),
  fetchMessage: jest.fn(),
  preview: jest.fn(),
  searchMyMessages: jest.fn(),
  buildThreadLink: jest.fn(),
  respondEphemeral: jest.fn(),
  reactToMessage: jest.fn(),
  deleteStartingReviewMessages: jest.fn(),
}));
jest.mock('../src/github', () => ({
  fetchPrData: jest.fn(),
  fetchPrTitle: jest.fn(),
  fetchPrCommits: jest.fn(),
  approvePr: jest.fn(),
}));
jest.mock('../src/review', () => ({
  runPrReview: jest.fn(),
  reviewSkipReason: jest.fn(),
  cancelReview: jest.fn(),
}));

const { transitionIssue, addComment, getIssue, getIssueSummary } = require('../src/jira');
const { fetchMessage, searchMyMessages, preview, replyToThread, buildThreadLink, respondEphemeral, reactToMessage, deleteStartingReviewMessages } = require('../src/slack');
const { fetchPrData, fetchPrTitle, fetchPrCommits, approvePr } = require('../src/github');
const { runPrReview, reviewSkipReason, cancelReview } = require('../src/review');

process.env.MY_SLACK_USER_ID = 'U093ZDNQJF3';
process.env.SLACK_REVIEW_CHANNEL = 'C05F65TBB9P';
process.env.JIRA_HOST = 'https://everfit.atlassian.net/';
process.env.ID_IN_REVIEW = '41';
process.env.ID_QA_READY = '51';
process.env.SLACK_SIGNING_SECRET = '';
process.env.QA_NOTIFY_DELAY_MINUTES = '15';
process.env.MY_GITHUB_USERNAME = 'huynguyen-everfit';

const request = require('supertest');
const app = require('../src/index');

/**
 * Polls `predicate` on a real timer until it's true. supertest drives a real
 * HTTP round trip (socket connect/write/body-parse), so a fixed number of
 * setImmediate/microtask ticks is not a reliable way to wait for a handler to
 * reach some point mid-flight — it can pass "by luck" without actually
 * exercising the code being tested. Polling on an observable side effect
 * (e.g. a mock's call count) is deterministic regardless of how many ticks
 * the real I/O underneath needs.
 */
function waitUntil(predicate, { timeout = 2000, interval = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitUntil: timed out'));
      setTimeout(check, interval);
    })();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  transitionIssue.mockResolvedValue(true);
  addComment.mockResolvedValue(undefined);
  getIssue.mockResolvedValue({ fields: { issuetype: { name: 'Task' }, description: null } });
  fetchPrTitle.mockResolvedValue('feat: UP-69726 some feature');
  fetchPrData.mockResolvedValue({ title: 'feat: UP-69726 some feature', baseBranch: 'develop' });
  fetchPrCommits.mockResolvedValue([]);
  approvePr.mockResolvedValue(true);
  fetchMessage.mockResolvedValue({
    text: '<https://github.com/Everfit-io/everfit-api/pull/16391>',
  });
  searchMyMessages.mockResolvedValue([]);
  preview.mockResolvedValue(undefined);
  getIssueSummary.mockResolvedValue(null);
  respondEphemeral.mockResolvedValue(true);
  reactToMessage.mockResolvedValue({ ok: true });
  deleteStartingReviewMessages.mockResolvedValue(0);
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

  test('does nothing when no Jira key is found in the message or the PR title', async () => {
    fetchPrTitle.mockResolvedValue('chore: cleanup dependencies');
    await request(app).post('/slack/events').send(
      reviewMessagePayload({ text: '<https://github.com/Everfit-io/everfit-api/pull/16391>' })
    );
    expect(transitionIssue).not.toHaveBeenCalled();
  });
});

// ─── POST /slack/events — signature verification ───────────────────────────────
//
// Every other describe block in this file runs with SLACK_SIGNING_SECRET=''
// (dev mode — verification skipped), so the actual HMAC check in
// verifySlackSignature() needs its own coverage with a real secret configured.

describe('POST /slack/events — signature verification', () => {
  const crypto = require('crypto');
  const SECRET = 'test-signing-secret';

  afterEach(() => {
    process.env.SLACK_SIGNING_SECRET = '';
  });

  function sign(rawBody, timestamp) {
    return 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  }

  test('accepts a correctly signed request and processes the event', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = JSON.stringify(reviewMessagePayload());
    const timestamp = String(Math.floor(Date.now() / 1000));

    await request(app)
      .post('/slack/events')
      .set('Content-Type', 'application/json')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', sign(raw, timestamp))
      .send(raw);

    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '41');
  });

  test('ignores a request with an incorrect signature', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = JSON.stringify(reviewMessagePayload());
    const timestamp = String(Math.floor(Date.now() / 1000));

    await request(app)
      .post('/slack/events')
      .set('Content-Type', 'application/json')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', 'v0=' + '0'.repeat(64))
      .send(raw);

    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores a request missing the signature headers', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    await request(app).post('/slack/events').send(reviewMessagePayload());
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores a replayed request older than 5 minutes', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = JSON.stringify(reviewMessagePayload());
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400);

    await request(app)
      .post('/slack/events')
      .set('Content-Type', 'application/json')
      .set('x-slack-request-timestamp', staleTimestamp)
      .set('x-slack-signature', sign(raw, staleTimestamp))
      .send(raw);

    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips verification entirely when SLACK_SIGNING_SECRET is unset (dev mode)', async () => {
    process.env.SLACK_SIGNING_SECRET = '';
    await request(app).post('/slack/events').send(reviewMessagePayload());
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '41');
  });

  test('always skips retried deliveries regardless of signature validity', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    await request(app)
      .post('/slack/events')
      .set('x-slack-retry-num', '1')
      .send(reviewMessagePayload());
    expect(transitionIssue).not.toHaveBeenCalled();
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
      item_user: 'U093ZDNQJF3', // my own message → routes to QA Ready flow
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

  test('does NOT transition before the delay elapses', async () => {
    await request(app).post('/slack/events').send(reactionPayload());
    // Timers have not been advanced yet → transition hasn't fired
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('transitions to QA Ready after the delay', async () => {
    await sendReaction();
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
      { message: 'feat: UP-100 thing', authorLogin: 'huynguyen-everfit', committerLogin: 'huynguyen-everfit' },
      { message: 'fix: UP-100 follow-up', authorLogin: 'huynguyen-everfit', committerLogin: 'huynguyen-everfit' }, // duplicate key
      { message: 'feat: UP-200 other', authorLogin: 'huynguyen-everfit', committerLogin: 'huynguyen-everfit' },
      { message: 'chore: UP-999 from teammate', authorLogin: 'someone-else', committerLogin: 'someone-else' }, // filtered out
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

  test('releasing_staging: cherry-picked commits (I am committer, not author) are included', async () => {
    fetchPrData.mockResolvedValue({ title: 'release', baseBranch: 'releasing_staging' });
    fetchPrCommits.mockResolvedValue([
      { message: 'fix: UP-300 cherry-picked from teammate', authorLogin: 'teammate', committerLogin: 'huynguyen-everfit' },
      { message: 'fix: UP-400 not mine at all', authorLogin: 'teammate', committerLogin: 'teammate' },
    ]);
    await sendReaction();
    expect(transitionIssue).toHaveBeenCalledWith('UP-300', '51');
    expect(transitionIssue).not.toHaveBeenCalledWith('UP-400', '51');
    expect(addComment).toHaveBeenCalledWith('UP-300', 'Ready for QA testing on STAGING');
  });

  test('releasing_staging: skips if no commits authored or committed by me have a Jira key', async () => {
    fetchPrData.mockResolvedValue({ title: 'release', baseBranch: 'releasing_staging' });
    fetchPrCommits.mockResolvedValue([
      { message: 'chore: UP-1 from someone else', authorLogin: 'someone-else', committerLogin: 'someone-else' },
    ]);
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('skips comment and Slack reply if transition returns false', async () => {
    transitionIssue.mockResolvedValue(false);
    await sendReaction();
    expect(addComment).not.toHaveBeenCalled();
  });

  test('does nothing when the original message cannot be fetched', async () => {
    fetchMessage.mockResolvedValue(null);
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('does nothing when the fetched message has no PR URL', async () => {
    fetchMessage.mockResolvedValue({ text: 'just chatting, no link here' });
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('does nothing when GitHub PR data cannot be fetched', async () => {
    fetchPrData.mockResolvedValue(null);
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('does nothing when no Jira key is found in message or PR title (non-releasing_staging)', async () => {
    fetchPrData.mockResolvedValue({ title: 'chore: cleanup', baseBranch: 'develop' });
    await sendReaction();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('logs but does not throw when a Bug ticket description has no matching Slack thread link', async () => {
    const { replyToThread } = require('../src/slack');
    getIssue.mockResolvedValue({
      fields: { issuetype: { name: 'Bug' }, description: 'no slack link in this description' },
    });
    await expect(sendReaction()).resolves.not.toThrow();
    expect(replyToThread).not.toHaveBeenCalled();
  });

  test('swallows errors thrown while resolving post-transition Bug/thread info', async () => {
    getIssue.mockRejectedValue(new Error('jira down'));
    await expect(sendReaction()).resolves.not.toThrow();
    // The transition itself (and comment) already happened before the failure.
    expect(transitionIssue).toHaveBeenCalledWith('UP-69726', '51');
    expect(addComment).toHaveBeenCalledWith('UP-69726', 'Ready for QA testing on DEV');
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
      { message: 'feat: UP-100 thing', authorLogin: 'huynguyen-everfit', committerLogin: 'huynguyen-everfit' },
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

// ─── GET /jira/tickets-by-day ─────────────────────────────────────────────────

describe('GET /jira/tickets-by-day', () => {
  test('rejects malformed date', async () => {
    const res = await request(app).get('/jira/tickets-by-day?date=2026/05/10');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  test('returns empty tickets when search returns nothing', async () => {
    searchMyMessages.mockResolvedValue([]);
    const res = await request(app).get('/jira/tickets-by-day?date=2026-05-10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: '2026-05-10', messagesScanned: 0, tickets: [] });
  });

  test('queries Slack search with `from:<@USER> on:DATE`', async () => {
    await request(app).get('/jira/tickets-by-day?date=2026-05-10');
    expect(searchMyMessages).toHaveBeenCalledWith('from:<@U093ZDNQJF3> on:2026-05-10');
  });

  test('returns flat deduped list of tickets across channels with summaries', async () => {
    searchMyMessages.mockResolvedValue([
      { text: 'review giup em UP-100', channel: { id: 'C1', name: 'backend-review-code' } },
      { text: 'fix UP-100 lan 2',      channel: { id: 'C1', name: 'backend-review-code' } }, // dupe
      { text: 'and also UP-200',       channel: { id: 'C1', name: 'backend-review-code' } },
      { text: 'standup: UP-300 va ABC-99', channel: { id: 'C2', name: 'team-be' } },
    ]);
    getIssueSummary.mockImplementation(async (key) => {
      if (key === 'UP-100') return 'Fix login bug';
      if (key === 'UP-200') return 'Add caching';
      if (key === 'UP-300') return null; // missing summary still appears
      return 'Some title';
    });

    const res = await request(app).get('/jira/tickets-by-day?date=2026-05-10');

    expect(res.status).toBe(200);
    expect(res.body.messagesScanned).toBe(4);
    expect(res.body.tickets).toEqual([
      { key: 'UP-100', summary: 'Fix login bug' },
      { key: 'UP-200', summary: 'Add caching' },
      { key: 'UP-300', summary: null },
      { key: 'ABC-99', summary: 'Some title' },
    ]);
  });

  test('excludes channels listed in IGNORED_AUDIT_CHANNELS', async () => {
    process.env.IGNORED_AUDIT_CHANNELS = 'C0AMZQ68TSP, CSOMETHING';
    searchMyMessages.mockResolvedValue([
      { text: 'UP-100 in noisy channel', channel: { id: 'C0AMZQ68TSP', name: 'noisy' } },
      { text: 'UP-200 in real work',     channel: { id: 'C1', name: 'team-be' } },
    ]);
    getIssueSummary.mockResolvedValue('title');

    const res = await request(app).get('/jira/tickets-by-day?date=2026-05-10');

    expect(res.body.messagesScanned).toBe(1);
    expect(res.body.tickets).toEqual([
      { key: 'UP-200', summary: 'title' },
    ]);
    delete process.env.IGNORED_AUDIT_CHANNELS;
  });

  test('preview includes a clickable Slack link per ticket with title', async () => {
    searchMyMessages.mockResolvedValue([
      { text: 'UP-100 done', channel: { id: 'C1', name: 'team-be' } },
    ]);
    getIssueSummary.mockResolvedValue('Fix login bug');

    await request(app).get('/jira/tickets-by-day?date=2026-05-10');

    expect(preview).toHaveBeenCalledTimes(1);
    const text = preview.mock.calls[0][0];
    expect(text).toContain('2026-05-10');
    expect(text).toContain('<https://everfit.atlassian.net/browse/UP-100|UP-100>: Fix login bug');
    expect(text).not.toContain('team-be'); // no channel header
  });

  test('preview shows just the link (no colon) when summary is null', async () => {
    searchMyMessages.mockResolvedValue([
      { text: 'UP-1', channel: { id: 'C1', name: 'team-be' } },
    ]);
    getIssueSummary.mockResolvedValue(null);

    await request(app).get('/jira/tickets-by-day?date=2026-05-10');
    const text = preview.mock.calls[0][0];
    expect(text).toContain('<https://everfit.atlassian.net/browse/UP-1|UP-1>');
    expect(text).not.toContain('UP-1: ');
  });
});

// ─── POST /slack/commands (slash commands) ────────────────────────────────────

describe('POST /slack/commands — /tickets', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
    searchMyMessages.mockResolvedValue([
      { text: 'standup: lam UP-100 va UP-200', channel: { id: 'C1', name: 'team-be', is_private: true } },
    ]);
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('silently ignores users other than MY_SLACK_USER_ID', async () => {
    const res = await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '',
        user_id: 'UOTHER',
        response_url: 'https://hooks.slack.com/x',
      });
    // Slack still needs a 200, but we send no body — nothing shown to the user
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(res.text).toBe('OK'); // Express sendStatus(200) default body
    expect(searchMyMessages).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('acks immediately with ephemeral "running" message', async () => {
    const res = await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/x',
      });
    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('ephemeral');
    expect(res.body.text).toContain('Running');
  });

  test('posts the audit report to response_url for default (today)', async () => {
    await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/RESPONSE',
      });

    // Allow async followup to flush
    await new Promise(setImmediate);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/RESPONSE');
    const body = JSON.parse(opts.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('<https://everfit.atlassian.net/browse/UP-100|UP-100>');
    expect(body.text).toContain('<https://everfit.atlassian.net/browse/UP-200|UP-200>');
    expect(body.text).not.toContain('team-be'); // no channel header in flat report
  });

  test('honours an explicit YYYY-MM-DD argument', async () => {
    await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '2026-05-09',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/RESPONSE',
      });
    await new Promise(setImmediate);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('2026-05-09');
  });

  test('rejects malformed date with ephemeral error', async () => {
    await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '2026/05/09',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/RESPONSE',
      });
    await new Promise(setImmediate);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toMatch(/Invalid date/);
    expect(searchMyMessages).not.toHaveBeenCalled();
  });

  test('replies with "unknown command" for unrecognised slash command', async () => {
    await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/something-else',
        text: '',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/RESPONSE',
      });
    await new Promise(setImmediate);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toMatch(/Unknown command/);
  });

  test('swallows an async failure in the /tickets follow-up without crashing the request', async () => {
    searchMyMessages.mockRejectedValue(new Error('slack search down'));
    const res = await request(app)
      .post('/slack/commands')
      .type('form')
      .send({
        command: '/tickets',
        text: '',
        user_id: 'U093ZDNQJF3',
        response_url: 'https://hooks.slack.com/RESPONSE',
      });
    await new Promise(setImmediate);

    expect(res.status).toBe(200); // the ack already went out before the failure
    expect(fetchMock).not.toHaveBeenCalled(); // the failed follow-up never reached response_url
  });

  test('swallows a response_url post failure without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(
      request(app)
        .post('/slack/commands')
        .type('form')
        .send({
          command: '/tickets',
          text: '',
          user_id: 'U093ZDNQJF3',
          response_url: 'https://hooks.slack.com/RESPONSE',
        })
    ).resolves.toBeDefined();
    await new Promise(setImmediate);
  });
});

describe('POST /slack/commands — signature verification', () => {
  const crypto = require('crypto');
  const SECRET = 'test-signing-secret';

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete global.fetch;
    process.env.SLACK_SIGNING_SECRET = '';
  });

  function sign(rawBody, timestamp) {
    return 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  }

  test('rejects an invalid signature with 401', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = 'command=%2Ftickets&text=&user_id=U093ZDNQJF3&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', 'v0=' + '0'.repeat(64))
      .send(raw);

    expect(res.status).toBe(401);
  });

  test('accepts a correctly signed request', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = 'command=%2Ftickets&text=&user_id=U093ZDNQJF3&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await request(app)
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', sign(raw, timestamp))
      .send(raw);

    expect(res.status).toBe(200);
    expect(res.body.response_type).toBe('ephemeral');
  });

  test('rejects a request missing the signature headers', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const res = await request(app)
      .post('/slack/commands')
      .type('form')
      .send({ command: '/tickets', text: '', user_id: 'U093ZDNQJF3', response_url: 'https://hooks.slack.com/x' });

    expect(res.status).toBe(401);
  });

  test('rejects a replayed request older than 5 minutes', async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const raw = 'command=%2Ftickets&text=&user_id=U093ZDNQJF3&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400);

    const res = await request(app)
      .post('/slack/commands')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp', staleTimestamp)
      .set('x-slack-signature', sign(raw, staleTimestamp))
      .send(raw);

    expect(res.status).toBe(401);
  });
});

// ─── handleApproveReaction (✅ on teammate's message) ──────────────────────────

function approvePayload(overrides = {}) {
  return {
    type: 'event_callback',
    event: {
      type: 'reaction_added',
      user: 'U093ZDNQJF3',           // me
      reaction: 'white_check_mark',
      item_user: 'UTEAMMATE',        // teammate posted the message
      item: {
        type: 'message',
        channel: 'C05F65TBB9P',      // SLACK_REVIEW_CHANNEL
        ts: '1712345678.901234',
      },
      ...overrides,
    },
  };
}

describe('handleApproveReaction', () => {
  beforeEach(() => {
    delete process.env.DRY_RUN;
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234',
      text: '<https://github.com/Everfit-io/everfit-api/pull/16391>',
    });
  });

  test('approves the single PR linked in a teammate message', async () => {
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).toHaveBeenCalledTimes(1);
    expect(approvePr).toHaveBeenCalledWith('https://github.com/Everfit-io/everfit-api/pull/16391');
  });

  test('approves every PR when the message contains multiple links', async () => {
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234',
      text: 'review giup em <https://github.com/Everfit-io/everfit-api/pull/100> va <https://github.com/Everfit-io/everfit-api/pull/200>',
    });
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).toHaveBeenCalledTimes(2);
    expect(approvePr).toHaveBeenCalledWith('https://github.com/Everfit-io/everfit-api/pull/100');
    expect(approvePr).toHaveBeenCalledWith('https://github.com/Everfit-io/everfit-api/pull/200');
  });

  test('dedupes repeated PR URLs in the same message', async () => {
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234',
      text: '<https://github.com/o/r/pull/1> and again <https://github.com/o/r/pull/1>',
    });
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).toHaveBeenCalledTimes(1);
  });

  test('ignores reactions from other users', async () => {
    await request(app).post('/slack/events').send(approvePayload({ user: 'UOTHER' }));
    expect(approvePr).not.toHaveBeenCalled();
  });

  test('ignores reactions from outside SLACK_REVIEW_CHANNEL', async () => {
    await request(app).post('/slack/events').send(
      approvePayload({ item: { type: 'message', channel: 'COTHER', ts: '1.2' } })
    );
    expect(approvePr).not.toHaveBeenCalled();
  });

  test('✅ on MY own message routes to QA flow, not approve', async () => {
    await request(app).post('/slack/events').send(
      approvePayload({ item_user: 'U093ZDNQJF3' })
    );
    expect(approvePr).not.toHaveBeenCalled();
    // QA flow side-effects exercised by the handleReactionAdded tests above; here we
    // only assert that approve is NOT triggered.
  });

  test('ignores messages without a GitHub PR link', async () => {
    fetchMessage.mockResolvedValue({ text: 'just a normal chat' });
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).not.toHaveBeenCalled();
  });

  test('does nothing when the original message cannot be fetched', async () => {
    fetchMessage.mockResolvedValue(null);
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).not.toHaveBeenCalled();
  });

  test('approves even when DRY_RUN=true (PR approval ignores DRY_RUN)', async () => {
    process.env.DRY_RUN = 'true';
    await request(app).post('/slack/events').send(approvePayload());
    expect(approvePr).toHaveBeenCalledTimes(1);
    delete process.env.DRY_RUN;
  });

  test('ignores reactions other than white_check_mark', async () => {
    await request(app).post('/slack/events').send(approvePayload({ reaction: 'thumbsup' }));
    expect(approvePr).not.toHaveBeenCalled();
  });

  test('skips approve flow when item_user is in IGNORED_TEAMMATE', async () => {
    process.env.IGNORED_TEAMMATE = 'U0A08M586LE,UTEAMMATE,U08BE96NYE6';
    await request(app).post('/slack/events').send(approvePayload({ item_user: 'UTEAMMATE' }));
    expect(approvePr).not.toHaveBeenCalled();
    expect(fetchMessage).not.toHaveBeenCalled();
    delete process.env.IGNORED_TEAMMATE;
  });

  test('still approves when item_user is not in IGNORED_TEAMMATE', async () => {
    process.env.IGNORED_TEAMMATE = 'U0A08M586LE,U08BE96NYE6';
    await request(app).post('/slack/events').send(approvePayload({ item_user: 'UTEAMMATE' }));
    expect(approvePr).toHaveBeenCalledTimes(1);
    delete process.env.IGNORED_TEAMMATE;
  });

  test('skips when reaction is on a thread reply (item ts !== fetched message ts)', async () => {
    // event.item.ts = the reply we reacted to, but conversations.history returns
    // the root (different ts) because thread replies aren't in channel history.
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234', // root
      text: '<https://github.com/Everfit-io/everfit-api/pull/16391>',
    });
    await request(app).post('/slack/events').send(approvePayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345999.000000' }, // reply ts
    }));
    expect(approvePr).not.toHaveBeenCalled();
  });
});

// ─── handleReviewRequestReaction (👀 → Claude Code review) ─────────────────────

const REVIEW_PR_URL = 'https://github.com/Everfit-io/everfit-api/pull/18647';
const REVIEW_COMMENT_URL = `${REVIEW_PR_URL}#issuecomment-5350479923`;

/** Block Kit body expected on the "Starting code review..." reply. */
function cancelBlocksFor(text, prUrl, prNumber) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        action_id: 'review_pr_cancel',
        text: { type: 'plain_text', text: `Cancel review of #${prNumber}`, emoji: true },
        value: prUrl,
        style: 'danger',
      }],
    },
  ];
}

function eyesPayload(overrides = {}) {
  return {
    type: 'event_callback',
    event: {
      type: 'reaction_added',
      user: 'U093ZDNQJF3',      // me
      reaction: 'eyes',
      item_user: 'UTEAMMATE',
      item: {
        type: 'message',
        channel: 'C05F65TBB9P', // SLACK_REVIEW_CHANNEL
        ts: '1712345678.901234',
      },
      ...overrides,
    },
  };
}

const REVIEW_THREAD_LINK = 'https://everfit.slack.com/archives/C05F65TBB9P/p1712345678901234';
const REVIEW_DIGEST = [
  '*Key findings (2 total):*',
  '',
  '🔴 *P1 — Must verify before ship*',
  '#1 Localization keys missing from the catalog → raw key strings in push',
  '',
  '🟡 *P2 — Should fix*',
  '#2 Empty actor name fires a malformed notification',
].join('\n');

describe('handleReviewRequestReaction', () => {
  beforeEach(() => {
    replyToThread.mockResolvedValue(undefined);
    buildThreadLink.mockReturnValue(REVIEW_THREAD_LINK);
    reviewSkipReason.mockReturnValue(null); // reviewable by default
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: REVIEW_COMMENT_URL,
      counts: { high: 2, medium: 3, low: 1 },
      summary: REVIEW_DIGEST,
    });
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234',
      text: `review giup em <${REVIEW_PR_URL}>`,
    });
  });

  test('announces the review, runs it, then posts the comment URL in the thread', async () => {
    await request(app).post('/slack/events').send(eyesPayload());

    expect(runPrReview).toHaveBeenCalledTimes(1);
    expect(runPrReview).toHaveBeenCalledWith(REVIEW_PR_URL);

    const startText = 'Starting code review for PR #18647. Will post results here shortly.';
    expect(replyToThread).toHaveBeenNthCalledWith(
      1,
      'C05F65TBB9P',
      '1712345678.901234',
      startText,
      { notify: false, blocks: cancelBlocksFor(startText, REVIEW_PR_URL, '18647') }
    );
    expect(replyToThread).toHaveBeenNthCalledWith(
      2,
      'C05F65TBB9P',
      '1712345678.901234',
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.\n\n${REVIEW_DIGEST}`,
      {
        notify: false,
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'actions',
            elements: [expect.objectContaining({
              action_id: 'review_pr_again',
              value: REVIEW_PR_URL,
            })],
          }),
        ]),
      }
    );
  });

  test('sweeps and deletes "Starting code review" messages before posting the completion reply', async () => {
    await request(app).post('/slack/events').send(eyesPayload());

    expect(deleteStartingReviewMessages).toHaveBeenCalledWith(
      'C05F65TBB9P', '1712345678.901234', '18647'
    );
    expect(deleteStartingReviewMessages.mock.invocationCallOrder[0]).toBeLessThan(
      replyToThread.mock.invocationCallOrder[1]
    );
  });

  test('does not attach the "Review again" button once the PR is approved', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: REVIEW_COMMENT_URL,
      counts: null,
      summary: null,
      verdict: { verdict: 'APPROVE', reason: 'clean', label: '✅ Ready to merge' },
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][3]?.blocks).toBeUndefined();
  });

  test('does not attach the button when nothing was posted', async () => {
    runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][3]?.blocks).toBeUndefined();
  });

  test('renders the comment URL as a Slack link label, not a raw URL', async () => {
    const doneText = () => replyToThread.mock.calls[1][2];
    await request(app).post('/slack/events').send(eyesPayload());

    expect(doneText()).toContain(`<${REVIEW_COMMENT_URL}|here>`);
    expect(doneText()).not.toContain(`at ${REVIEW_COMMENT_URL}`);
  });

  test('appends the run\'s findings digest below the link', async () => {
    await request(app).post('/slack/events').send(eyesPayload());

    const doneText = replyToThread.mock.calls[1][2];
    expect(doneText).toContain('*Key findings (2 total):*');
    expect(doneText).toContain('🔴 *P1 — Must verify before ship*');
    expect(doneText).toContain('#2 Empty actor name fires a malformed notification');
    // Digest wins over the bare counts when both are present.
    expect(doneText).not.toContain('High ·');
  });

  test('falls back to per-severity counts when the run sent no digest', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: REVIEW_COMMENT_URL,
      counts: { high: 0, medium: 4, low: 0 },
      summary: null,
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toContain('(🔴 0 High · 🟡 4 Medium · 🟢 0 Low)');
  });

  test('omits the recap entirely when the run reported neither', async () => {
    runPrReview.mockResolvedValue({
      ok: true, commentUrl: REVIEW_COMMENT_URL, counts: null, summary: null,
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toBe(
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.`
    );
  });

  test('replaces the ready-to-merge badge with the approval line', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: REVIEW_COMMENT_URL,
      counts: { high: 0, medium: 0, low: 1 },
      summary: REVIEW_DIGEST,
      verdict: { verdict: 'APPROVE', reason: 'no blocking issues found', label: '✅ Ready to merge' },
    });
    await request(app).post('/slack/events').send(eyesPayload());

    const doneText = replyToThread.mock.calls[1][2];
    expect(doneText).toBe(
      `✅ *Approved on GitHub* — no blocking issues found · <${REVIEW_COMMENT_URL}|full review>\n\n${REVIEW_DIGEST}`
    );
  });

  test('collapses to one approval line when nothing was posted (all Confirmed Safe)', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: null,
      counts: { high: 0, medium: 0, low: 0 },
      summary: null,
      verdict: { verdict: 'APPROVE', reason: 'clean pass, nothing to flag', label: '✅ Ready to merge' },
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toBe(
      '✅ *Approved on GitHub* — clean pass, nothing to flag'
    );
  });

  test('shows a "needs changes" badge without a reason', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: REVIEW_COMMENT_URL,
      counts: null,
      summary: null,
      verdict: { verdict: 'REQUEST_CHANGES', reason: null, label: '🚫 Needs changes' },
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toBe(
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.\n*🚫 Needs changes*`
    );
  });

  test('omits the verdict badge when the run reported none', async () => {
    runPrReview.mockResolvedValue({
      ok: true, commentUrl: REVIEW_COMMENT_URL, counts: null, summary: null, verdict: null,
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toBe(
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.`
    );
  });

  test('emits no preview at all on success — the thread reply is the only output', async () => {
    await request(app).post('/slack/events').send(eyesPayload());

    // Both replies pass notify: false, so replyToThread contributes no previews either.
    expect(replyToThread.mock.calls.every(c => c[3]?.notify === false)).toBe(true);
    expect(preview).not.toHaveBeenCalled();
  });

  test('failure preview links back to the reacted Slack thread, shortened', async () => {
    runPrReview.mockResolvedValue({ ok: false, error: 'boom' });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(buildThreadLink).toHaveBeenCalledWith('C05F65TBB9P', '1712345678.901234');
    expect(preview.mock.calls[0][0]).toContain(`<${REVIEW_THREAD_LINK}|Go to thread>`);
  });

  test('failure preview omits the thread line when SLACK_WORKSPACE is unset', async () => {
    buildThreadLink.mockReturnValue(null);
    runPrReview.mockResolvedValue({ ok: false, error: 'boom' });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(preview.mock.calls[0][0]).not.toContain('Go to thread');
  });

  test('says nothing was posted when the review found nothing', async () => {
    runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: { high: 0, medium: 0, low: 0 } });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread).toHaveBeenNthCalledWith(
      2,
      'C05F65TBB9P',
      '1712345678.901234',
      '✅ *Approved on GitHub* — no blocking findings.',
      { notify: false }
    );
  });

  test('reports failures to the preview channel only, not the team thread', async () => {
    runPrReview.mockResolvedValue({ ok: false, error: 'claude exited 1: boom' });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread).toHaveBeenCalledTimes(1); // only the "starting" reply
    const previewText = preview.mock.calls.map(c => c[0]).join('\n');
    expect(previewText).toContain('Code review failed');
    expect(previewText).toContain('claude exited 1: boom');
    // A failure never reaches the "starting" message cleanup — it stays as-is.
    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
  });

  test('reviews every PR linked in the message, deduped', async () => {
    fetchMessage.mockResolvedValue({
      ts: '1712345678.901234',
      text: 'em co 2 PR <https://github.com/Everfit-io/everfit-api/pull/100> va <https://github.com/Everfit-io/everfit-api/pull/200> va lai <https://github.com/Everfit-io/everfit-api/pull/100>',
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(runPrReview).toHaveBeenCalledTimes(2);
    expect(runPrReview).toHaveBeenCalledWith('https://github.com/Everfit-io/everfit-api/pull/100');
    expect(runPrReview).toHaveBeenCalledWith('https://github.com/Everfit-io/everfit-api/pull/200');
  });

  test('reviews my own message too (👀 is not routed by item_user)', async () => {
    await request(app).post('/slack/events').send(eyesPayload({ item_user: 'U093ZDNQJF3' }));
    expect(runPrReview).toHaveBeenCalledTimes(1);
  });

  test('ignores 👀 from other users', async () => {
    await request(app).post('/slack/events').send(eyesPayload({ user: 'UOTHER' }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores 👀 outside SLACK_REVIEW_CHANNEL', async () => {
    await request(app).post('/slack/events').send(
      eyesPayload({ item: { type: 'message', channel: 'COTHER', ts: '1.2' } })
    );
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores messages without a GitHub PR link', async () => {
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: 'just a normal chat' });
    await request(app).post('/slack/events').send(eyesPayload());
    expect(runPrReview).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });

  test('does nothing when the original message cannot be fetched', async () => {
    fetchMessage.mockResolvedValue(null);
    await request(app).post('/slack/events').send(eyesPayload());
    expect(runPrReview).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });

  test('skips when 👀 is on a thread reply (item ts !== fetched message ts)', async () => {
    await request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345999.000000' },
    }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('does not approve when findings were posted and no verdict came back', async () => {
    await request(app).post('/slack/events').send(eyesPayload());
    expect(approvePr).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('never touches Jira — 👀 only reviews', async () => {
    runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
    await request(app).post('/slack/events').send(eyesPayload());
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores a second 👀 while the same PR is still under review, then allows one after it finishes', async () => {
    let finishFirst;
    runPrReview.mockImplementationOnce(() => new Promise(resolve => {
      finishFirst = () => resolve({ ok: true, commentUrl: REVIEW_COMMENT_URL });
    }));

    const first = request(app).post('/slack/events').send(eyesPayload());
    first.catch(() => {});
    // Wait until the first run is genuinely parked inside the never-resolving
    // runPrReview call — it only gets there after reviewsInFlight.add(prUrl),
    // so this proves the guard is armed before the duplicate is sent.
    await waitUntil(() => runPrReview.mock.calls.length === 1);

    const second = request(app).post('/slack/events').send(eyesPayload());
    second.catch(() => {}); // supertest requests are lazy until awaited/then'd
    // fetchMessage is called unconditionally on every 👀, guard or not — wait
    // for it so we know the duplicate's handler actually ran to completion,
    // rather than the assertion below passing only because it hadn't yet.
    await waitUntil(() => fetchMessage.mock.calls.length === 2);
    await second;

    expect(runPrReview).toHaveBeenCalledTimes(1); // the in-flight guard caught the duplicate

    finishFirst();
    await first;

    // Guard releases once the first run finishes — a third 👀 now goes through.
    await request(app).post('/slack/events').send(eyesPayload());
    await waitUntil(() => runPrReview.mock.calls.length === 2);
  });

  test('skips a disallowed repo without ever announcing the review in the thread', async () => {
    reviewSkipReason.mockReturnValue(
      '"everfit-cms" is not in REVIEW_ALLOWED_REPOS (everfit-api, file-service)'
    );
    await request(app).post('/slack/events').send(eyesPayload());

    expect(runPrReview).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled(); // no dangling "Starting code review"
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0][0]).toContain('Code review skipped');
    expect(preview.mock.calls[0][0]).toContain('not in REVIEW_ALLOWED_REPOS');
  });

  test('skip preview still links back to the reacted thread', async () => {
    reviewSkipReason.mockReturnValue('no local clone for "everfit-cms"');
    await request(app).post('/slack/events').send(eyesPayload());

    expect(preview.mock.calls[0][0]).toContain(`<${REVIEW_THREAD_LINK}|Go to thread>`);
  });

  // ─── auto-approval on a clean review ───────────────────────────────────────

  describe('auto-approval', () => {
    beforeEach(() => {
      approvePr.mockResolvedValue(true);
    });

    test('approves on GitHub when the verdict is APPROVE, even with findings posted', async () => {
      runPrReview.mockResolvedValue({
        ok: true,
        commentUrl: REVIEW_COMMENT_URL,
        counts: { high: 0, medium: 0, low: 1 },
        summary: REVIEW_DIGEST,
        verdict: { verdict: 'APPROVE', reason: 'only nits left', label: '✅ Ready to merge' },
      });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).toHaveBeenCalledWith(
        REVIEW_PR_URL,
        '✅ Auto-approved after an automated code review — only nits left'
      );
      expect(replyToThread.mock.calls[1][2]).toBe(
        `✅ *Approved on GitHub* — only nits left · <${REVIEW_COMMENT_URL}|full review>\n\n${REVIEW_DIGEST}`
      );
      expect(reactToMessage).toHaveBeenCalledWith('C05F65TBB9P', '1712345678.901234', 'white_check_mark');
    });

    test('approves when nothing was posted and no verdict came back', async () => {
      runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).toHaveBeenCalledWith(
        REVIEW_PR_URL,
        '✅ Auto-approved after an automated code review — no blocking findings.'
      );
      expect(replyToThread.mock.calls[1][2]).toBe('✅ *Approved on GitHub* — no blocking findings.');
      expect(reactToMessage).toHaveBeenCalledWith('C05F65TBB9P', '1712345678.901234', 'white_check_mark');
    });

    test('the approved reply says it once — no "review is complete" or badge above it', async () => {
      runPrReview.mockResolvedValue({
        ok: true,
        commentUrl: REVIEW_COMMENT_URL,
        counts: { high: 0, medium: 0, low: 1 },
        summary: null,
        verdict: { verdict: 'APPROVE', reason: 'only nits left', label: '✅ Ready to merge' },
      });
      await request(app).post('/slack/events').send(eyesPayload());

      const doneText = replyToThread.mock.calls[1][2];
      expect(doneText).not.toContain('The review is complete');
      expect(doneText).not.toContain('Ready to merge');
      expect(doneText.split('\n')[0]).toBe(
        `✅ *Approved on GitHub* — only nits left · <${REVIEW_COMMENT_URL}|full review> (🔴 0 High · 🟡 0 Medium · 🟢 1 Low)`
      );
    });

    test('does not approve when the verdict asks for changes, even with nothing posted', async () => {
      runPrReview.mockResolvedValue({
        ok: true,
        commentUrl: null,
        counts: null,
        summary: null,
        verdict: { verdict: 'REQUEST_CHANGES', reason: 'design needs rework', label: '🚫 Needs changes' },
      });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).not.toHaveBeenCalled();
      expect(replyToThread.mock.calls[1][2]).not.toContain('Approved on GitHub');
      expect(reactToMessage).not.toHaveBeenCalled();
    });

    test('does not approve a COMMENT verdict with findings posted', async () => {
      runPrReview.mockResolvedValue({
        ok: true,
        commentUrl: REVIEW_COMMENT_URL,
        counts: null,
        summary: null,
        verdict: { verdict: 'COMMENT', reason: 'worth a look', label: '💬 Reviewed' },
      });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).not.toHaveBeenCalled();
    });

    test('a failed approval is previewed, never claimed in the thread', async () => {
      approvePr.mockResolvedValue(false);
      runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(replyToThread.mock.calls[1][2]).toBe('The review is complete — no findings to post.');
      expect(preview).toHaveBeenCalledTimes(1);
      expect(preview.mock.calls[0][0]).toContain('PR auto-approve failed');
      expect(preview.mock.calls[0][0]).toContain(`<${REVIEW_THREAD_LINK}|Go to thread>`);
      expect(preview.mock.calls[0][1]).toEqual({ tag: false });
      expect(reactToMessage).not.toHaveBeenCalled();
    });

    test('a failed reaction is previewed with the Slack error, even though the approval succeeded', async () => {
      reactToMessage.mockResolvedValue({ ok: false, error: 'missing_scope' });
      runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).toHaveBeenCalledTimes(1);
      expect(replyToThread.mock.calls[1][2]).toBe('✅ *Approved on GitHub* — no blocking findings.');
      expect(preview).toHaveBeenCalledTimes(1);
      expect(preview.mock.calls[0][0]).toContain('reaction failed');
      expect(preview.mock.calls[0][0]).toContain('missing_scope');
      expect(preview.mock.calls[0][1]).toEqual({ tag: false });
    });

    test('a successful approval stays silent in the preview channel', async () => {
      runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(preview).not.toHaveBeenCalled();
    });

    test('approves regardless of DRY_RUN', async () => {
      process.env.DRY_RUN = 'true';
      runPrReview.mockResolvedValue({ ok: true, commentUrl: null, counts: null, summary: null });
      await request(app).post('/slack/events').send(eyesPayload());

      expect(approvePr).toHaveBeenCalledTimes(1);
      delete process.env.DRY_RUN;
    });
  });
});

// ─── handleDeleteStartingReviewsReaction (🗑️ → manual "Starting review" cleanup) ──

function wastebasketPayload(overrides = {}) {
  return {
    type: 'event_callback',
    event: {
      type: 'reaction_added',
      user: 'U093ZDNQJF3', // me
      reaction: 'wastebasket',
      item_user: 'UTEAMMATE',
      item: {
        type: 'message',
        channel: 'C05F65TBB9P', // SLACK_REVIEW_CHANNEL
        ts: '1712345678.901234',
      },
      ...overrides,
    },
  };
}

describe('handleDeleteStartingReviewsReaction', () => {
  beforeEach(() => {
    buildThreadLink.mockReturnValue(REVIEW_THREAD_LINK);
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: 'whatever is in this thread' });
    deleteStartingReviewMessages.mockResolvedValue(2);
  });

  test('sweeps the thread with no PR number and previews the count', async () => {
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(deleteStartingReviewMessages).toHaveBeenCalledWith('C05F65TBB9P', '1712345678.901234');
    expect(preview).toHaveBeenCalledWith(
      `🗑️ *Deleted 2 "Starting review" messages*\n<${REVIEW_THREAD_LINK}|Go to thread>`,
      { tag: false }
    );
  });

  test('singularizes the preview text when exactly one message was deleted', async () => {
    deleteStartingReviewMessages.mockResolvedValue(1);
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(preview).toHaveBeenCalledWith(
      `🗑️ *Deleted 1 "Starting review" message*\n<${REVIEW_THREAD_LINK}|Go to thread>`,
      { tag: false }
    );
  });

  test('previews zero deletions too — never silently swallows the reaction', async () => {
    deleteStartingReviewMessages.mockResolvedValue(0);
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(preview.mock.calls[0][0]).toContain('Deleted 0 "Starting review" messages');
  });

  test('omits the thread line when SLACK_WORKSPACE is unset', async () => {
    buildThreadLink.mockReturnValue(null);
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(preview.mock.calls[0][0]).not.toContain('Go to thread');
  });

  test('ignores 🗑️ from other users', async () => {
    await request(app).post('/slack/events').send(wastebasketPayload({ user: 'UOTHER' }));
    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
  });

  test('ignores 🗑️ outside SLACK_REVIEW_CHANNEL', async () => {
    await request(app).post('/slack/events').send(
      wastebasketPayload({ item: { type: 'message', channel: 'COTHER', ts: '1.2' } })
    );
    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
  });

  test('skips when 🗑️ is on a thread reply (item ts !== fetched root ts)', async () => {
    fetchMessage.mockResolvedValue({ ts: '1712345999.000000', text: 'a reply, not the root' });
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  test('does nothing when the reacted message cannot be fetched', async () => {
    fetchMessage.mockResolvedValue(null);
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  test('never touches Jira, GitHub, or the team thread', async () => {
    await request(app).post('/slack/events').send(wastebasketPayload());

    expect(transitionIssue).not.toHaveBeenCalled();
    expect(approvePr).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });
});

// ─── POST /slack/interactive — "Review again" button ───────────────────────────

function reviewAgainPayload(overrides = {}) {
  return {
    type: 'block_actions',
    user: { id: 'UTEAMMATE' },
    channel: { id: 'C05F65TBB9P' },
    message: { ts: '1712345678.901234', thread_ts: '1712345678.901234' },
    response_url: 'https://hooks.slack.com/actions/T000/123/abc',
    actions: [{ action_id: 'review_pr_again', value: REVIEW_PR_URL }],
    ...overrides,
  };
}

function postInteraction(payload) {
  return request(app)
    .post('/slack/interactive')
    .type('form')
    .send({ payload: JSON.stringify(payload) });
}

describe('POST /slack/interactive — Review again button', () => {
  // The teammate budget is a real per-PR counter with no test-only reset (a
  // process restart is the only reset in production), so every independent
  // test below uses its own PR URL/number to stay isolated from the others.
  let n = 20000;
  const freshPrUrl = () => `https://github.com/Everfit-io/everfit-api/pull/${n++}`;

  beforeEach(() => {
    runPrReview.mockResolvedValue({ ok: true, commentUrl: REVIEW_COMMENT_URL, counts: null, summary: null });
    buildThreadLink.mockReturnValue(null);
  });

  test('a teammate click starts a re-review in the original thread', async () => {
    const prUrl = freshPrUrl();
    const prNumber = prUrl.match(/\/pull\/(\d+)/)[1];
    await postInteraction(reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] }));

    expect(runPrReview).toHaveBeenCalledWith(prUrl);
    const startText = `Starting code review for PR #${prNumber}. Will post results here shortly.`;
    expect(replyToThread.mock.calls[0]).toEqual([
      'C05F65TBB9P',
      '1712345678.901234',
      startText,
      { notify: false, blocks: cancelBlocksFor(startText, prUrl, prNumber) },
    ]);
  });

  test('the owner can click unlimited times', async () => {
    const prUrl = freshPrUrl();
    const owner = () => reviewAgainPayload({
      user: { id: 'U093ZDNQJF3' },
      actions: [{ action_id: 'review_pr_again', value: prUrl }],
    });
    await postInteraction(owner());
    await postInteraction(owner());
    await postInteraction(owner());

    expect(runPrReview).toHaveBeenCalledTimes(3);
    expect(respondEphemeral).not.toHaveBeenCalled();
  });

  test('teammates are capped at 2 re-reviews per PR', async () => {
    const prUrl = freshPrUrl();
    const click = () => reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] });

    await postInteraction(click());
    await postInteraction(click());
    expect(runPrReview).toHaveBeenCalledTimes(2);

    await postInteraction(click());
    expect(runPrReview).toHaveBeenCalledTimes(2); // third click blocked
    expect(respondEphemeral).toHaveBeenCalledWith(
      click().response_url,
      expect.stringContaining('already been re-reviewed 2 times')
    );
  });

  test('the teammate cap is per PR, not global', async () => {
    const prUrl = freshPrUrl();
    const otherPrUrl = freshPrUrl();
    const click = url => reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: url }] });

    await postInteraction(click(prUrl));
    await postInteraction(click(prUrl));
    await postInteraction(click(otherPrUrl));

    expect(runPrReview).toHaveBeenCalledTimes(3);
    expect(runPrReview).toHaveBeenCalledWith(otherPrUrl);
  });

  test('a different teammate is still bound by the same PR budget', async () => {
    const prUrl = freshPrUrl();
    const click = userId => reviewAgainPayload({
      user: { id: userId },
      actions: [{ action_id: 'review_pr_again', value: prUrl }],
    });

    await postInteraction(click('UTEAMMATE_A'));
    await postInteraction(click('UTEAMMATE_B'));
    await postInteraction(click('UTEAMMATE_C'));

    expect(runPrReview).toHaveBeenCalledTimes(2);
  });

  test('does not start a duplicate run while one is already in flight', async () => {
    const prUrl = freshPrUrl();
    const click = () => reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] });

    let finishFirst;
    runPrReview.mockImplementationOnce(() => new Promise(resolve => {
      finishFirst = () => resolve({ ok: true, commentUrl: REVIEW_COMMENT_URL });
    }));

    // supertest only actually sends a request once something calls .then()/
    // .catch() on it; a bare assignment leaves it un-dispatched. Attach a no-op
    // catch immediately so click #1 is genuinely in flight before click #2 fires.
    const first = postInteraction(click());
    first.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    await postInteraction(click());

    expect(runPrReview).toHaveBeenCalledTimes(1);
    expect(respondEphemeral).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('being reviewed right now')
    );

    finishFirst();
    await first;
  });

  test('an in-flight click does not consume a teammate\'s budget', async () => {
    const prUrl = freshPrUrl();
    const click = () => reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] });

    let finishFirst;
    runPrReview.mockImplementationOnce(() => new Promise(resolve => {
      finishFirst = () => resolve({ ok: true, commentUrl: REVIEW_COMMENT_URL });
    }));

    // Click #1 starts a run and spends slot 1/2 of the teammate budget. Attach
    // a no-op catch immediately — supertest doesn't actually send a request
    // until something calls .then()/.catch() on it.
    const first = postInteraction(click());
    first.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    // Click #2 arrives while #1 is still running — blocked by the in-flight
    // guard, before the budget check ever runs. It must spend nothing.
    await postInteraction(click());
    finishFirst();
    await first;

    // If click #2 had wrongly spent the last slot, the budget would already be
    // exhausted here. Instead exactly one more click succeeds (slot 2/2)...
    await postInteraction(click());
    expect(runPrReview).toHaveBeenCalledTimes(2); // click #1 + this one

    // ...and the next is the real third teammate attempt — over budget.
    await postInteraction(click());
    expect(runPrReview).toHaveBeenCalledTimes(2); // capped
  });

  test('ignores payloads for other action ids', async () => {
    const prUrl = freshPrUrl();
    await postInteraction(reviewAgainPayload({ actions: [{ action_id: 'something_else', value: prUrl }] }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores non block_actions payloads', async () => {
    await postInteraction(reviewAgainPayload({ type: 'view_submission' }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores an unparseable payload instead of crashing', async () => {
    await request(app)
      .post('/slack/interactive')
      .type('form')
      .send({ payload: 'not-json{' });
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores a click missing channel or message context', async () => {
    const prUrl = freshPrUrl();
    await postInteraction(reviewAgainPayload({
      channel: undefined,
      actions: [{ action_id: 'review_pr_again', value: prUrl }],
    }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('ignores a click with no PR URL in the button value', async () => {
    await postInteraction(reviewAgainPayload({
      actions: [{ action_id: 'review_pr_again', value: '' }],
    }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  describe('signature verification', () => {
    const crypto = require('crypto');
    const SECRET = 'test-signing-secret';

    afterEach(() => {
      process.env.SLACK_SIGNING_SECRET = '';
    });

    test('ignores an interaction with an invalid signature', async () => {
      process.env.SLACK_SIGNING_SECRET = SECRET;
      const prUrl = freshPrUrl();
      const raw = `payload=${encodeURIComponent(JSON.stringify(
        reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] })
      ))}`;
      const timestamp = String(Math.floor(Date.now() / 1000));

      await request(app)
        .post('/slack/interactive')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('x-slack-request-timestamp', timestamp)
        .set('x-slack-signature', 'v0=' + '0'.repeat(64))
        .send(raw);

      expect(runPrReview).not.toHaveBeenCalled();
    });

    test('accepts a correctly signed interaction', async () => {
      process.env.SLACK_SIGNING_SECRET = SECRET;
      const prUrl = freshPrUrl();
      const raw = `payload=${encodeURIComponent(JSON.stringify(
        reviewAgainPayload({ actions: [{ action_id: 'review_pr_again', value: prUrl }] })
      ))}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');

      await request(app)
        .post('/slack/interactive')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .set('x-slack-request-timestamp', timestamp)
        .set('x-slack-signature', sig)
        .send(raw);

      expect(runPrReview).toHaveBeenCalledWith(prUrl);
    });
  });
});

// ─── POST /slack/interactive — "Cancel review" button ──────────────────────────

function cancelPayload(overrides = {}) {
  return {
    type: 'block_actions',
    user: { id: 'U093ZDNQJF3' }, // owner — only the owner may cancel a review
    channel: { id: 'C05F65TBB9P' },
    message: { ts: '1712345678.901234', thread_ts: '1712345678.901234' },
    response_url: 'https://hooks.slack.com/actions/T000/123/abc',
    actions: [{ action_id: 'review_pr_cancel', value: REVIEW_PR_URL }],
    ...overrides,
  };
}

describe('POST /slack/interactive — Cancel review button', () => {
  let n = 30000;
  const freshPrUrl = () => `https://github.com/Everfit-io/everfit-api/pull/${n++}`;

  beforeEach(() => {
    cancelReview.mockReturnValue(true);
    buildThreadLink.mockReturnValue(null);
  });

  test('ignores a click missing channel or message context', async () => {
    await postInteraction(cancelPayload({ channel: undefined }));
    expect(cancelReview).not.toHaveBeenCalled();
  });

  test('rejects a cancel click from anyone but the owner, even for a review actually in flight', async () => {
    const prUrl = freshPrUrl();
    runPrReview.mockImplementationOnce(() => new Promise(() => {}));
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: `<${prUrl}>` });
    const eyesReq = request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345678.901234' },
    }));
    eyesReq.catch(() => {});
    await waitUntil(() => runPrReview.mock.calls.some(c => c[0] === prUrl));

    await postInteraction(cancelPayload({
      user: { id: 'UTEAMMATE' },
      actions: [{ action_id: 'review_pr_cancel', value: prUrl }],
    }));

    expect(cancelReview).not.toHaveBeenCalled();
    // The only replyToThread call so far is the unrelated "Starting..." reply —
    // no cancellation announcement went out.
    expect(replyToThread).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.stringContaining('cancelled by'), expect.anything()
    );
    expect(respondEphemeral).toHaveBeenCalledWith(
      'https://hooks.slack.com/actions/T000/123/abc',
      'Only <@U093ZDNQJF3> can cancel a review.'
    );
  });

  test('tells the clicker there is nothing to cancel when the PR is not under review', async () => {
    const prUrl = freshPrUrl(); // never started via 👀, so reviewsInFlight never has it
    await postInteraction(cancelPayload({ actions: [{ action_id: 'review_pr_cancel', value: prUrl }] }));

    expect(cancelReview).not.toHaveBeenCalled();
    expect(respondEphemeral).toHaveBeenCalledWith(
      'https://hooks.slack.com/actions/T000/123/abc',
      expect.stringContaining("isn't currently under review")
    );
    expect(replyToThread).not.toHaveBeenCalled();
  });

  test('cancels an in-flight review and announces it in the thread', async () => {
    const prUrl = freshPrUrl();
    const prNumber = prUrl.match(/\/pull\/(\d+)/)[1];

    // Get the PR into reviewsInFlight via a real 👀 review that never resolves.
    runPrReview.mockImplementationOnce(() => new Promise(() => {}));
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: `<${prUrl}>` });
    const eyesReq = request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345678.901234' },
    }));
    eyesReq.catch(() => {});
    await waitUntil(() => runPrReview.mock.calls.some(c => c[0] === prUrl));

    await postInteraction(cancelPayload({
      actions: [{ action_id: 'review_pr_cancel', value: prUrl }],
    }));

    expect(cancelReview).toHaveBeenCalledWith(prUrl);
    expect(replyToThread).toHaveBeenCalledWith(
      'C05F65TBB9P',
      '1712345678.901234',
      `❌ Review of PR #${prNumber} cancelled by <@U093ZDNQJF3>.`,
      { notify: false }
    );
    expect(respondEphemeral).not.toHaveBeenCalled();
  });

  test('tells the clicker to retry when cancelReview loses the race', async () => {
    const prUrl = freshPrUrl();

    runPrReview.mockImplementationOnce(() => new Promise(() => {}));
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: `<${prUrl}>` });
    const eyesReq = request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345678.901234' },
    }));
    eyesReq.catch(() => {});
    await waitUntil(() => runPrReview.mock.calls.some(c => c[0] === prUrl));

    cancelReview.mockReturnValue(false);
    await postInteraction(cancelPayload({
      actions: [{ action_id: 'review_pr_cancel', value: prUrl }],
    }));

    expect(respondEphemeral).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Couldn't cancel")
    );
    expect(replyToThread).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.stringContaining('cancelled by'), expect.anything()
    );
  });

  test('a cancelled review posts no further completion message, and releases the PR for a later review', async () => {
    const prUrl = freshPrUrl();
    let resolveRun;
    runPrReview.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
    fetchMessage.mockResolvedValue({ ts: '1712345678.901234', text: `<${prUrl}>` });

    const eyesReq = request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345678.901234' },
    }));
    eyesReq.catch(() => {});
    await waitUntil(() => runPrReview.mock.calls.some(c => c[0] === prUrl));

    await postInteraction(cancelPayload({ actions: [{ action_id: 'review_pr_cancel', value: prUrl }] }));
    replyToThread.mockClear();

    // The killed process actually closes now — runPrReview resolves cancelled.
    resolveRun({ ok: false, cancelled: true, error: 'cancelled' });
    await eyesReq;

    // No "review is complete" / approval message — the cancel click already said it.
    expect(replyToThread).not.toHaveBeenCalled();
    // The "starting" message is left in place on cancellation, not deleted.
    expect(deleteStartingReviewMessages).not.toHaveBeenCalled();
    expect(approvePr).not.toHaveBeenCalled();

    // reviewsInFlight must be released once the cancelled run settles (the
    // `finally` in runReviewForPr always runs, even on this early return) —
    // otherwise the PR would be stuck "under review" forever. Confirmed by
    // retrying a plain 👀 until it actually starts a second run: the resolved
    // promise's continuation (the cancelled check + finally cleanup) is a
    // same-process microtask chain with no real I/O, so this settles almost
    // immediately, but a bounded retry loop is used instead of a fixed
    // sleep/tick count to stay deterministic regardless of exact timing.
    const deadline = Date.now() + 2000;
    let started = false;
    while (!started && Date.now() < deadline) {
      const retryReq = request(app).post('/slack/events').send(eyesPayload({
        item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345678.901234' },
      }));
      retryReq.catch(() => {});
      try {
        await waitUntil(() => runPrReview.mock.calls.filter(c => c[0] === prUrl).length === 2, { timeout: 100 });
        started = true;
      } catch {
        // reviewsInFlight not released yet — loop and try again.
      }
    }
    expect(started).toBe(true);
  });
});
