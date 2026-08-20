'use strict';

const mockPostMessage = jest.fn();
const mockHistory = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: mockPostMessage },
    conversations: { history: mockHistory },
  })),
}));

const { replyToThread, preview } = require('../src/slack');

beforeEach(() => {
  jest.clearAllMocks();
  mockPostMessage.mockResolvedValue({});
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
