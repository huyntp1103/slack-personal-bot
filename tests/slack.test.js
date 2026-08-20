'use strict';

const mockPostMessage = jest.fn();
const mockHistory = jest.fn();
const mockReactionsAdd = jest.fn();
const mockSearchMessages = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    conversations: { history: mockHistory },
    reactions: { add: mockReactionsAdd },
    search: { messages: mockSearchMessages },
  })),
}));

const { replyToThread, preview, reactToMessage, fetchMessage, searchMyMessages, respondEphemeral } = require('../src/slack');

beforeEach(() => {
  jest.clearAllMocks();
  mockPostMessage.mockResolvedValue({});
  mockReactionsAdd.mockResolvedValue({});
  process.env.SLACK_PREVIEW_CHANNEL = 'C_PREVIEW';
  delete process.env.DRY_RUN;
  delete process.env.SLACK_WORKSPACE;
  delete process.env.MY_SLACK_USER_ID;
});

describe('replyToThread — preview link', () => {
  test('includes clickable archive URL when SLACK_WORKSPACE is set', async () => {
    process.env.SLACK_WORKSPACE = 'everfit';
    process.env.DRY_RUN = 'true';

    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello');

    // First call is the preview (DRY_RUN=true so no real reply call after)
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const previewText = mockPostMessage.mock.calls[0][0].text;
    expect(previewText).toContain(
      'https://everfit.slack.com/archives/C0APHQYK456/p1778214715118289'
    );
    expect(previewText).toContain('hello');
  });

  test('falls back to channel/ts display when SLACK_WORKSPACE is unset', async () => {
    process.env.DRY_RUN = 'true';

    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello');

    const previewText = mockPostMessage.mock.calls[0][0].text;
    expect(previewText).not.toContain('slack.com/archives');
    expect(previewText).toContain('C0APHQYK456');
    expect(previewText).toContain('1778214715.118289');
  });

  test('notify: false skips the "Replied in Slack" preview but still replies', async () => {
    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello', { notify: false });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0]).toEqual({
      channel: 'C0APHQYK456',
      thread_ts: '1778214715.118289',
      text: 'hello',
    });
  });

  test('notify: false still previews under DRY_RUN — it is the only output there', async () => {
    process.env.DRY_RUN = 'true';

    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello', { notify: false });

    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    expect(mockPostMessage.mock.calls[0][0].channel).toBe('C_PREVIEW');
    expect(mockPostMessage.mock.calls[0][0].text).toContain('hello');
  });

  test('still posts the real reply when DRY_RUN is not true', async () => {
    process.env.SLACK_WORKSPACE = 'everfit';

    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello');

    // First: preview to SLACK_PREVIEW_CHANNEL. Second: actual thread reply.
    expect(mockPostMessage).toHaveBeenCalledTimes(2);
    expect(mockPostMessage.mock.calls[1][0]).toEqual({
      channel: 'C0APHQYK456',
      thread_ts: '1778214715.118289',
      text: 'hello',
    });
  });
});

describe('preview — owner tagging', () => {
  test('appends <@MY_SLACK_USER_ID> on a new line at the end', async () => {
    process.env.MY_SLACK_USER_ID = 'U093ZDNQJF3';

    await preview('🔄 *Jira transition*\nTicket: `UP-1`');

    const text = mockPostMessage.mock.calls[0][0].text;
    expect(text.endsWith('\n<@U093ZDNQJF3>')).toBe(true);
    expect(text).toContain('🔄 *Jira transition*');
  });

  test('skips tagging when opts.tag === false', async () => {
    process.env.MY_SLACK_USER_ID = 'U093ZDNQJF3';

    await preview('✅ *PR approved*', { tag: false });

    const text = mockPostMessage.mock.calls[0][0].text;
    expect(text).not.toContain('<@U093ZDNQJF3>');
    expect(text).toBe('✅ *PR approved*');
  });

  test('skips tagging when MY_SLACK_USER_ID is unset', async () => {
    await preview('🔄 *Jira transition*');
    const text = mockPostMessage.mock.calls[0][0].text;
    expect(text).not.toContain('<@');
  });
});

describe('reactToMessage', () => {
  test('adds the reaction for real when DRY_RUN is not true', async () => {
    const result = await reactToMessage('C0APHQYK456', '1778214715.118289', 'white_check_mark');

    expect(mockReactionsAdd).toHaveBeenCalledWith({
      channel: 'C0APHQYK456',
      timestamp: '1778214715.118289',
      name: 'white_check_mark',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  test('previews instead of reacting for real under DRY_RUN', async () => {
    process.env.DRY_RUN = 'true';

    const result = await reactToMessage('C0APHQYK456', '1778214715.118289', 'white_check_mark');

    expect(mockReactionsAdd).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const previewText = mockPostMessage.mock.calls[0][0].text;
    expect(previewText).toContain('white_check_mark');
    expect(previewText).toContain('C0APHQYK456');
    expect(result).toEqual({ ok: true });
  });

  test('swallows already_reacted without treating it as a failure', async () => {
    const err = new Error('already_reacted');
    err.data = { error: 'already_reacted' };
    mockReactionsAdd.mockRejectedValue(err);

    await expect(
      reactToMessage('C0APHQYK456', '1778214715.118289', 'white_check_mark')
    ).resolves.toEqual({ ok: true });
  });

  test('reports the Slack error code on failure instead of throwing', async () => {
    const err = new Error('An API error occurred: missing_scope');
    err.data = { error: 'missing_scope' };
    mockReactionsAdd.mockRejectedValue(err);

    await expect(
      reactToMessage('C0APHQYK456', '1778214715.118289', 'white_check_mark')
    ).resolves.toEqual({ ok: false, error: 'missing_scope' });
  });

  test('falls back to the raw error message when the failure has no Slack error code', async () => {
    mockReactionsAdd.mockRejectedValue(new Error('network blip'));

    await expect(
      reactToMessage('C0APHQYK456', '1778214715.118289', 'white_check_mark')
    ).resolves.toEqual({ ok: false, error: 'network blip' });
  });
});

describe('replyToThread — failure handling and blocks', () => {
  test('logs but does not throw when the real postMessage call rejects', async () => {
    // Call #1 is the "✅ Replied in Slack" preview (succeeds); call #2 is the
    // actual thread reply, which fails.
    mockPostMessage.mockResolvedValueOnce({});
    mockPostMessage.mockRejectedValueOnce(new Error('channel_not_found'));

    await expect(
      replyToThread('C0APHQYK456', '1778214715.118289', 'hello')
    ).resolves.toBeUndefined();
  });

  test('includes blocks in the real postMessage call when provided', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];

    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello', { notify: false, blocks });

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: 'C0APHQYK456',
      thread_ts: '1778214715.118289',
      text: 'hello',
      blocks,
    });
  });

  test('omits the blocks key entirely when not provided', async () => {
    await replyToThread('C0APHQYK456', '1778214715.118289', 'hello', { notify: false });

    const call = mockPostMessage.mock.calls[0][0];
    expect(call).not.toHaveProperty('blocks');
  });
});

describe('preview — postMessage failure', () => {
  test('logs but does not throw when the preview post fails', async () => {
    process.env.SLACK_PREVIEW_CHANNEL = 'C_PREVIEW';
    mockPostMessage.mockRejectedValue(new Error('channel_not_found'));

    await expect(preview('hello')).resolves.toBeUndefined();
  });

  test('does nothing beyond logging when SLACK_PREVIEW_CHANNEL is unset', async () => {
    delete process.env.SLACK_PREVIEW_CHANNEL;

    await preview('hello');

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});

describe('fetchMessage', () => {
  test('returns the first message from conversations.history', async () => {
    mockHistory.mockResolvedValue({ messages: [{ ts: '123.456', text: 'hi' }] });

    const result = await fetchMessage('C0APHQYK456', '123.456');

    expect(mockHistory).toHaveBeenCalledWith({
      channel: 'C0APHQYK456',
      latest: '123.456',
      limit: 1,
      inclusive: true,
    });
    expect(result).toEqual({ ts: '123.456', text: 'hi' });
  });

  test('returns null when no message is found', async () => {
    mockHistory.mockResolvedValue({ messages: [] });
    const result = await fetchMessage('C0APHQYK456', '123.456');
    expect(result).toBeNull();
  });

  test('returns null and swallows the error on API failure', async () => {
    mockHistory.mockRejectedValue(new Error('channel_not_found'));
    const result = await fetchMessage('C0APHQYK456', '123.456');
    expect(result).toBeNull();
  });
});

describe('searchMyMessages', () => {
  test('returns matches from a single page', async () => {
    mockSearchMessages.mockResolvedValue({
      messages: { matches: [{ text: 'a' }, { text: 'b' }], paging: { pages: 1 } },
    });

    const result = await searchMyMessages('from:<@U1> on:2026-05-09');

    expect(mockSearchMessages).toHaveBeenCalledWith({
      query: 'from:<@U1> on:2026-05-09',
      count: 100,
      sort: 'timestamp',
      sort_dir: 'desc',
      page: 1,
    });
    expect(result).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  test('paginates across multiple pages and concatenates matches', async () => {
    mockSearchMessages
      .mockResolvedValueOnce({ messages: { matches: [{ text: 'page1' }], paging: { pages: 3 } } })
      .mockResolvedValueOnce({ messages: { matches: [{ text: 'page2' }], paging: { pages: 3 } } })
      .mockResolvedValueOnce({ messages: { matches: [{ text: 'page3' }], paging: { pages: 3 } } });

    const result = await searchMyMessages('query');

    expect(mockSearchMessages).toHaveBeenCalledTimes(3);
    expect(mockSearchMessages).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
    expect(mockSearchMessages).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
    expect(mockSearchMessages).toHaveBeenNthCalledWith(3, expect.objectContaining({ page: 3 }));
    expect(result).toEqual([{ text: 'page1' }, { text: 'page2' }, { text: 'page3' }]);
  });

  test('stops at the 50-page safety cap even if more pages are reported', async () => {
    mockSearchMessages.mockResolvedValue({
      messages: { matches: [{ text: 'x' }], paging: { pages: 9999 } },
    });

    await searchMyMessages('query');

    expect(mockSearchMessages).toHaveBeenCalledTimes(50);
  });

  test('returns an empty array and swallows the error on API failure', async () => {
    mockSearchMessages.mockRejectedValue(new Error('rate_limited'));
    const result = await searchMyMessages('query');
    expect(result).toEqual([]);
  });

  test('falls back to an empty page when matches/paging are missing from the response', async () => {
    mockSearchMessages.mockResolvedValue({ messages: {} });
    const result = await searchMyMessages('query');
    expect(result).toEqual([]);
    expect(mockSearchMessages).toHaveBeenCalledTimes(1); // paging.pages defaults to 1 — no extra pages fetched
  });

  test('returns whatever was collected before a mid-pagination failure', async () => {
    mockSearchMessages
      .mockResolvedValueOnce({ messages: { matches: [{ text: 'page1' }], paging: { pages: 3 } } })
      .mockRejectedValueOnce(new Error('rate_limited'));

    const result = await searchMyMessages('query');

    expect(result).toEqual([{ text: 'page1' }]);
  });
});

describe('respondEphemeral', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('posts an ephemeral, non-replacing response and returns true on success', async () => {
    const result = await respondEphemeral('https://hooks.slack.com/actions/x', 'hello');

    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/actions/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: 'hello' }),
    });
    expect(result).toBe(true);
  });

  test('returns false without throwing when responseUrl is falsy', async () => {
    const result = await respondEphemeral(undefined, 'hello');
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns false when Slack responds with a non-ok status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const result = await respondEphemeral('https://hooks.slack.com/actions/x', 'hello');
    expect(result).toBe(false);
  });

  test('returns false and swallows the error on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await respondEphemeral('https://hooks.slack.com/actions/x', 'hello');
    expect(result).toBe(false);
  });
});
