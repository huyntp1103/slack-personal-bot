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
}));

const { transitionIssue, addComment, getIssue, getIssueSummary } = require('../src/jira');
const { fetchMessage, searchMyMessages, preview, replyToThread, buildThreadLink } = require('../src/slack');
const { fetchPrData, fetchPrTitle, fetchPrCommits, approvePr } = require('../src/github');
const { runPrReview, reviewSkipReason } = require('../src/review');

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

    expect(replyToThread).toHaveBeenNthCalledWith(
      1,
      'C05F65TBB9P',
      '1712345678.901234',
      'Starting code review for PR #18647. Will post results here shortly.',
      { notify: false }
    );
    expect(replyToThread).toHaveBeenNthCalledWith(
      2,
      'C05F65TBB9P',
      '1712345678.901234',
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.\n\n${REVIEW_DIGEST}`,
      { notify: false }
    );
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

  test('shows a "ready to merge" badge so the team can approve manually', async () => {
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
      `The review is complete; please view it <${REVIEW_COMMENT_URL}|here>.\n*✅ Ready to merge* — no blocking issues found\n\n${REVIEW_DIGEST}`
    );
  });

  test('shows the verdict badge even when nothing was posted (all Confirmed Safe)', async () => {
    runPrReview.mockResolvedValue({
      ok: true,
      commentUrl: null,
      counts: { high: 0, medium: 0, low: 0 },
      summary: null,
      verdict: { verdict: 'APPROVE', reason: 'clean pass, nothing to flag', label: '✅ Ready to merge' },
    });
    await request(app).post('/slack/events').send(eyesPayload());

    expect(replyToThread.mock.calls[1][2]).toBe(
      'The review is complete — no findings to post.\n*✅ Ready to merge* — clean pass, nothing to flag'
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
      'The review is complete — no findings to post.',
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

  test('skips when 👀 is on a thread reply (item ts !== fetched message ts)', async () => {
    await request(app).post('/slack/events').send(eyesPayload({
      item: { type: 'message', channel: 'C05F65TBB9P', ts: '1712345999.000000' },
    }));
    expect(runPrReview).not.toHaveBeenCalled();
  });

  test('does not approve the PR — 👀 only reviews', async () => {
    await request(app).post('/slack/events').send(eyesPayload());
    expect(approvePr).not.toHaveBeenCalled();
    expect(transitionIssue).not.toHaveBeenCalled();
  });

  test('ignores a second 👀 while the same PR is still under review', async () => {
    let finishFirst;
    runPrReview.mockImplementationOnce(() => new Promise(resolve => {
      finishFirst = () => resolve({ ok: true, commentUrl: REVIEW_COMMENT_URL });
    }));

    const first = request(app).post('/slack/events').send(eyesPayload());
    // Let the first run reach runPrReview before the duplicate arrives.
    await new Promise(resolve => setImmediate(resolve));
    await request(app).post('/slack/events').send(eyesPayload());

    expect(runPrReview).toHaveBeenCalledTimes(1);

    finishFirst();
    await first;
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
});
