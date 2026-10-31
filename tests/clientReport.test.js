'use strict';

const path = require('path');
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn(), unlinkSync: jest.fn() }));

const { spawn } = require('child_process');
const fs = require('fs');
const {
  runClientReport,
  clientReportSkipReason,
  extractClientReportSummary,
  extractSessionId,
  extractNotePaths,
  deleteClientReportNote,
  sessionLine,
  HEADLESS_POLICY,
  FOLLOW_UP_PREFIX,
} = require('../src/clientReport');

const REPO_ROOT = '/Users/me/Everfit';
const REPO = path.join(REPO_ROOT, 'everfit-api');
const SKILL = path.join(REPO, '.claude', 'skills', 'client-report', 'SKILL.md');
const LINK = 'https://everfitt.slack.com/archives/C03H5DCAZ45/p1774413157652859';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REVIEW_REPO_ROOT = REPO_ROOT;
  delete process.env.REVIEW_CLAUDE_MODEL;
  delete process.env.REVIEW_PERMISSION_MODE;
  delete process.env.CLAUDE_BIN;
  delete process.env.REVIEW_TIMEOUT_MINUTES;
  fs.existsSync.mockReturnValue(true);
});

describe('extractClientReportSummary', () => {
  test('returns the text between the markers', () => {
    const out = 'noise\nCLIENT_REPORT_SUMMARY_START\n*Báo cáo*\nTriệu chứng: x\nCLIENT_REPORT_SUMMARY_END\n';
    expect(extractClientReportSummary(out)).toBe('*Báo cáo*\nTriệu chứng: x');
  });

  test('uses the last block and tolerates backtick/bold-wrapped markers', () => {
    const out = '`CLIENT_REPORT_SUMMARY_START`\nfirst\n`CLIENT_REPORT_SUMMARY_END`\n**CLIENT_REPORT_SUMMARY_START**\nsecond\n**CLIENT_REPORT_SUMMARY_END**';
    expect(extractClientReportSummary(out)).toBe('second');
  });

  test('null when there are no markers, an empty block, or no output', () => {
    expect(extractClientReportSummary('just text')).toBeNull();
    expect(extractClientReportSummary('CLIENT_REPORT_SUMMARY_START\n\nCLIENT_REPORT_SUMMARY_END')).toBeNull();
    expect(extractClientReportSummary(undefined)).toBeNull();
  });

  test('truncates a runaway digest', () => {
    const out = `CLIENT_REPORT_SUMMARY_START\n${'a'.repeat(5000)}\nCLIENT_REPORT_SUMMARY_END`;
    const summary = extractClientReportSummary(out);
    expect(summary.startsWith('a'.repeat(2800))).toBe(true);
    expect(summary.endsWith('_…tóm tắt bị cắt — xem ghi chú đầy đủ trong repo._')).toBe(true);
  });
});

describe('clientReportSkipReason', () => {
  test('null when the clone and the skill exist', () => {
    expect(clientReportSkipReason()).toBeNull();
  });

  test('explains a missing clone', () => {
    fs.existsSync.mockReturnValue(false);
    expect(clientReportSkipReason()).toBe(`no local clone for "everfit-api" (REVIEW_REPO_ROOT=${REPO_ROOT})`);
  });

  test('explains a missing REVIEW_REPO_ROOT', () => {
    delete process.env.REVIEW_REPO_ROOT;
    expect(clientReportSkipReason()).toBe('no local clone for "everfit-api" (REVIEW_REPO_ROOT=unset)');
  });

  test('explains a clone without the skill', () => {
    fs.existsSync.mockImplementation(p => p !== SKILL);
    expect(clientReportSkipReason()).toBe(`client-report skill not found at ${SKILL}`);
  });
});

describe('runClientReport', () => {
  test('does not spawn when it cannot run', async () => {
    fs.existsSync.mockReturnValue(false);
    const result = await runClientReport(LINK);
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns claude in the everfit-api clone with the investigate command, policy and model', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runClientReport(LINK, { model: 'claude-sonnet-5-5' });
    child.stdout.emit('data', 'CLIENT_REPORT_SUMMARY_START\nxong\nCLIENT_REPORT_SUMMARY_END');
    child.emit('close', 0);
    const result = await promise;

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      [
        '-p', `/client-report investigate ${LINK}`,
        '--session-id', result.sessionId,
        '--append-system-prompt', HEADLESS_POLICY,
        '--permission-mode', 'bypassPermissions',
        '--model', 'claude-sonnet-5-5',
      ],
      expect.objectContaining({ cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('xong');
  });

  test('honours CLAUDE_BIN, REVIEW_PERMISSION_MODE and falls back to REVIEW_CLAUDE_MODEL', async () => {
    process.env.CLAUDE_BIN = '/bin/claude';
    process.env.REVIEW_PERMISSION_MODE = 'acceptEdits';
    process.env.REVIEW_CLAUDE_MODEL = 'fallback-model';
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runClientReport(LINK);
    child.emit('close', 0);
    await promise;

    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('/bin/claude');
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits', '--model', 'fallback-model']));
  });

  test('ok with a null summary when the run printed no digest', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK);
    child.stdout.emit('data', 'did stuff');
    child.emit('close', 0);
    expect(await promise).toEqual(expect.objectContaining({ ok: true, summary: null }));
  });

  test('a non-zero exit after the digest was emitted is still a success', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK);
    child.stdout.emit('data', 'CLIENT_REPORT_SUMMARY_START\nxong\nCLIENT_REPORT_SUMMARY_END');
    child.emit('close', 1);
    expect(await promise).toEqual(expect.objectContaining({ ok: true, summary: 'xong' }));
  });

  test('a non-zero exit with no digest fails with the stderr tail', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK);
    child.stderr.emit('data', 'Not logged in');
    child.emit('close', 1);
    expect(await promise).toEqual({ ok: false, error: 'claude exited 1: Not logged in', output: '' });
  });

  test('falls back to stdout for the error tail when stderr is empty', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK);
    child.stdout.emit('data', 'partial');
    child.emit('close', 2);
    expect((await promise).error).toBe('claude exited 2: partial');
  });

  test('a spawn that throws resolves as a failure', async () => {
    spawn.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(await runClientReport(LINK)).toEqual({ ok: false, error: 'ENOENT' });
  });

  test('a child "error" event resolves as a failure', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK);
    child.emit('error', new Error('spawn claude ENOENT'));
    expect(await promise).toEqual({ ok: false, error: 'spawn claude ENOENT' });
  });

  test('kills a run that exceeds the timeout', async () => {
    jest.useFakeTimers();
    try {
      process.env.REVIEW_TIMEOUT_MINUTES = '1';
      const child = fakeChild();
      spawn.mockReturnValue(child);
      const promise = runClientReport(LINK);

      jest.advanceTimersByTime(60 * 1000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null);

      expect(await promise).toEqual({ ok: false, error: 'client report timed out after 1 min', output: '' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('follow-up runs', () => {
  const SESSION = '0b0f3c1e-5d2a-4a7e-9c11-2f6f1a9d8e77';

  async function run(opts) {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const promise = runClientReport(LINK, opts);
    child.stdout.emit('data', 'CLIENT_REPORT_SUMMARY_START\nxong\nCLIENT_REPORT_SUMMARY_END');
    child.emit('close', 0);
    return { result: await promise, args: spawn.mock.calls[0][1] };
  }

  test('a hint with a known session resumes it instead of starting over', async () => {
    const { result, args } = await run({ hint: 'check the consumer', resumeSessionId: SESSION });

    expect(args.slice(0, 4)).toEqual([
      '-p',
      `${FOLLOW_UP_PREFIX}check the consumer`,
      '--resume', SESSION,
    ]);
    expect(args).toContain(HEADLESS_POLICY);
    expect(args).not.toContain('--session-id');
    expect(result.sessionId).toBe(SESSION);
  });

  test('a hint without a session re-runs the skill on the thread with the hint as symptom text', async () => {
    const { result, args } = await run({ hint: 'check the consumer' });

    expect(args[1]).toBe(`/client-report investigate ${LINK} check the consumer`);
    expect(args[2]).toBe('--session-id');
    expect(args).not.toContain('--resume');
    expect(result.sessionId).toBe(args[3]);
  });

  test('a session id without a hint is ignored — it is a first run', async () => {
    const { args } = await run({ resumeSessionId: SESSION });

    expect(args[1]).toBe(`/client-report investigate ${LINK}`);
    expect(args).toContain('--session-id');
    expect(args).not.toContain(SESSION);
  });
});

describe('session marker', () => {
  const A = '0b0f3c1e-5d2a-4a7e-9c11-2f6f1a9d8e77';
  const B = '11111111-2222-4333-8444-555555555555';

  test('sessionLine renders the footer', () => {
    expect(sessionLine(A)).toBe(`🧵 session \`${A}\``);
  });

  test('extractSessionId reads it back, newest message first', () => {
    const messages = [{ text: 'root' }, { text: `a\n${sessionLine(A)}` }, { text: `b\n${sessionLine(B)}` }];
    expect(extractSessionId(messages)).toBe(B);
  });

  test('reads the footer back when Slack stored the emoji as :thread:', () => {
    expect(extractSessionId([{ text: `x\n:thread: session \`${A}\`` }])).toBe(A);
  });

  test('null when no message carries a (valid) session', () => {
    expect(extractSessionId([{ text: 'root' }, { text: '🧵 session `not-a-uuid`' }, {}])).toBeNull();
    expect(extractSessionId([])).toBeNull();
    expect(extractSessionId(undefined)).toBeNull();
  });
});

describe('HEADLESS_POLICY', () => {
  test('pins investigate mode, forbids questions and asks for a Vietnamese digest', () => {
    expect(HEADLESS_POLICY).toContain('`investigate` mode');
    expect(HEADLESS_POLICY).toContain('never stop to ask');
    expect(HEADLESS_POLICY).toContain('Vietnamese');
    expect(HEADLESS_POLICY).toContain('CLIENT_REPORT_SUMMARY_START');
    expect(HEADLESS_POLICY).toContain('CLIENT_REPORT_SUMMARY_END');
  });
});

describe('extractNotePaths', () => {
  const NOTE = 'ai-agents-output/client-reports-checking/training/autoflow/2026-10-31-duplicate-workouts.md';

  test('finds the saved note in a summary reply, with or without backticks', () => {
    expect(extractNotePaths([
      { text: 'root' },
      { text: `*File đã lưu:* \`${NOTE}\`` },
    ])).toEqual([NOTE]);
    expect(extractNotePaths([{ text: 'root' }, { text: `File đã lưu: ${NOTE}` }])).toEqual([NOTE]);
  });

  test('dedupes, keeps order, and never scans the root message', () => {
    const other = 'ai-agents-output/client-reports-checking/x/other.md';
    expect(extractNotePaths([
      { text: `root ${other}` },
      { text: `\`${NOTE}\`` },
      { text: `\`${other}\` and \`${NOTE}\`` },
    ])).toEqual([NOTE, other]);
  });

  test('returns [] when nothing is mentioned or input is empty', () => {
    expect(extractNotePaths([{ text: 'root' }, { text: 'no files here' }, {}])).toEqual([]);
    expect(extractNotePaths(null)).toEqual([]);
  });
});

describe('deleteClientReportNote', () => {
  const NOTE = 'ai-agents-output/client-reports-checking/training/a.md';

  test('unlinks the note inside the everfit-api clone', () => {
    expect(deleteClientReportNote(NOTE)).toEqual({ ok: true });
    expect(fs.unlinkSync).toHaveBeenCalledWith(path.join(REPO, NOTE));
  });

  test('an already-missing file counts as done', () => {
    fs.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
    expect(deleteClientReportNote(NOTE)).toEqual({ ok: true, missing: true });
  });

  test('other fs errors are reported', () => {
    fs.unlinkSync.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(deleteClientReportNote(NOTE)).toEqual({ ok: false, error: 'denied' });
  });

  test.each([
    'ai-agents-output/client-reports-checking/../../secrets.md',
    'ai-agents-output/other/a.md',
    'ai-agents-output/client-reports-checking/a.txt',
    '/etc/passwd',
  ])('refuses %s', rel => {
    const res = deleteClientReportNote(rel);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refusing to delete/);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  test('fails when there is no local clone', () => {
    fs.existsSync.mockReturnValue(false);
    expect(deleteClientReportNote(NOTE)).toEqual({ ok: false, error: 'no local clone for "everfit-api"' });
  });
});

describe('follow-up prompt', () => {
  test('asks the digest to lead with the answer and say what changed in the note', () => {
    expect(FOLLOW_UP_PREFIX).toContain('`*Trả lời:*');
    expect(FOLLOW_UP_PREFIX).toContain('`*Cập nhật ghi chú:*');
    expect(FOLLOW_UP_PREFIX).toContain('Update the saved note');
    expect(FOLLOW_UP_PREFIX.endsWith('Reviewer message:\n')).toBe(true);
  });
});
