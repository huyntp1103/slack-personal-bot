'use strict';

const path = require('path');
const { EventEmitter } = require('events');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

const { spawn } = require('child_process');
const fs = require('fs');
const {
  runPrReview,
  parsePrUrl,
  resolveRepoPath,
  isRepoAllowed,
  reviewSkipReason,
  extractCommentUrl,
  extractCounts,
  extractSummary,
  extractVerdict,
  HEADLESS_POLICY,
} = require('../src/review');

const PR_URL = 'https://github.com/Everfit-io/everfit-api/pull/18647';
const REPO_ROOT = '/Users/me/Everfit';

/** Minimal stand-in for a spawned child process. */
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
  delete process.env.REVIEW_ALLOWED_REPOS;
  fs.existsSync.mockReturnValue(true);
});

// ─── parsePrUrl ───────────────────────────────────────────────────────────────

describe('parsePrUrl', () => {
  test('extracts owner, repo and number', () => {
    expect(parsePrUrl(PR_URL)).toEqual({
      owner: 'Everfit-io',
      repo: 'everfit-api',
      number: '18647',
    });
  });

  test('returns null for non-PR input', () => {
    expect(parsePrUrl('https://github.com/Everfit-io/everfit-api/issues/12')).toBeNull();
    expect(parsePrUrl('')).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
  });
});

// ─── resolveRepoPath ──────────────────────────────────────────────────────────

describe('resolveRepoPath', () => {
  test('returns REVIEW_REPO_ROOT/<repo> when it is a git repo', () => {
    expect(resolveRepoPath('everfit-api')).toBe(path.join(REPO_ROOT, 'everfit-api'));
    expect(fs.existsSync).toHaveBeenCalledWith(path.join(REPO_ROOT, 'everfit-api', '.git'));
  });

  test('returns null when the directory is not a git repo', () => {
    fs.existsSync.mockReturnValue(false);
    expect(resolveRepoPath('unknown-repo')).toBeNull();
  });

  test('returns null when REVIEW_REPO_ROOT is unset', () => {
    delete process.env.REVIEW_REPO_ROOT;
    expect(resolveRepoPath('everfit-api')).toBeNull();
  });
});

// ─── isRepoAllowed / reviewSkipReason ─────────────────────────────────────────

describe('isRepoAllowed', () => {
  test('allows any repo when REVIEW_ALLOWED_REPOS is unset', () => {
    expect(isRepoAllowed('everfit-api')).toBe(true);
    expect(isRepoAllowed('some-random-repo')).toBe(true);
  });

  test('restricts to the comma-separated allowlist when set', () => {
    process.env.REVIEW_ALLOWED_REPOS = 'everfit-api, file-service';
    expect(isRepoAllowed('everfit-api')).toBe(true);
    expect(isRepoAllowed('file-service')).toBe(true);
    expect(isRepoAllowed('everfit-cms-api')).toBe(false);
  });
});

describe('reviewSkipReason', () => {
  test('null when the PR is reviewable', () => {
    expect(reviewSkipReason(PR_URL)).toBeNull();
  });

  test('flags a non-PR URL', () => {
    expect(reviewSkipReason('https://github.com/Everfit-io/everfit-api')).toMatch(/not a GitHub PR URL/);
  });

  test('flags a repo outside REVIEW_ALLOWED_REPOS before checking for a clone', () => {
    process.env.REVIEW_ALLOWED_REPOS = 'file-service';
    expect(reviewSkipReason(PR_URL)).toMatch(/"everfit-api" is not in REVIEW_ALLOWED_REPOS/);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  test('flags a missing local clone when the repo is allowed', () => {
    fs.existsSync.mockReturnValue(false);
    expect(reviewSkipReason(PR_URL)).toMatch(/no local clone for "everfit-api"/);
  });
});

// ─── extractCommentUrl ────────────────────────────────────────────────────────

describe('extractCommentUrl', () => {
  test('reads the REVIEW_RESULT marker', () => {
    const out = `review text\nREVIEW_RESULT=${PR_URL}#issuecomment-5350479923\n`;
    expect(extractCommentUrl(out)).toBe(`${PR_URL}#issuecomment-5350479923`);
  });

  test('uses the last marker when several appear', () => {
    const out = `REVIEW_RESULT=NONE\nposted after all\nREVIEW_RESULT=${PR_URL}#issuecomment-2`;
    expect(extractCommentUrl(out)).toBe(`${PR_URL}#issuecomment-2`);
  });

  test('returns null for REVIEW_RESULT=NONE', () => {
    expect(extractCommentUrl('no findings\nREVIEW_RESULT=NONE')).toBeNull();
  });

  test('strips trailing punctuation and markdown', () => {
    expect(extractCommentUrl(`REVIEW_RESULT=${PR_URL}#issuecomment-9\`.`))
      .toBe(`${PR_URL}#issuecomment-9`);
  });

  test('falls back to a GitHub comment anchor when the marker is missing', () => {
    const out = `Posted the review: ${PR_URL}#pullrequestreview-123456`;
    expect(extractCommentUrl(out)).toBe(`${PR_URL}#pullrequestreview-123456`);
  });

  test('returns null when there is nothing to find', () => {
    expect(extractCommentUrl('review printed, nothing posted')).toBeNull();
    expect(extractCommentUrl('')).toBeNull();
    expect(extractCommentUrl(undefined)).toBeNull();
  });
});

// ─── extractCounts ────────────────────────────────────────────────────────────

describe('extractCounts', () => {
  test('reads the REVIEW_COUNTS marker', () => {
    expect(extractCounts('REVIEW_COUNTS=high=2,medium=3,low=1'))
      .toEqual({ high: 2, medium: 3, low: 1 });
  });

  test('tolerates spacing and ordering', () => {
    expect(extractCounts('REVIEW_COUNTS= low = 4 , high= 0 , medium =2 '))
      .toEqual({ high: 0, medium: 2, low: 4 });
  });

  test('treats an omitted severity as zero', () => {
    expect(extractCounts('REVIEW_COUNTS=high=1')).toEqual({ high: 1, medium: 0, low: 0 });
  });

  test('uses the last marker when several appear', () => {
    expect(extractCounts('REVIEW_COUNTS=high=9\nREVIEW_COUNTS=high=1,medium=1,low=1'))
      .toEqual({ high: 1, medium: 1, low: 1 });
  });

  test('returns null when the run reported no counts', () => {
    expect(extractCounts('just a review')).toBeNull();
    expect(extractCounts('REVIEW_COUNTS=unknown')).toBeNull();
    expect(extractCounts('')).toBeNull();
    expect(extractCounts(undefined)).toBeNull();
  });
});

// ─── extractSummary ───────────────────────────────────────────────────────────

const DIGEST = [
  '*Key findings (3 total):*',
  '',
  '🔴 *P1 — Must verify before ship*',
  '#1 Localization keys not in any catalog → non-English users see raw key strings',
  '',
  '🟡 *P2 — Should fix*',
  '#2 Empty actor name fires a malformed notification — fix: `if (!actorName) return;`',
  '',
  '🟢 *P3*',
  '#3 Reply-level dispatch path untested',
].join('\n');

describe('extractSummary', () => {
  test('pulls the digest out from between the markers', () => {
    const out = `blah\nREVIEW_SUMMARY_START\n${DIGEST}\nREVIEW_SUMMARY_END\nREVIEW_RESULT=${PR_URL}#issuecomment-1`;
    expect(extractSummary(out)).toBe(DIGEST);
  });

  test('tolerates markers the model decorated with backticks or bold', () => {
    const out = `\`REVIEW_SUMMARY_START\`\n${DIGEST}\n**REVIEW_SUMMARY_END**`;
    expect(extractSummary(out)).toBe(DIGEST);
  });

  test('uses the last block when the markers appear twice', () => {
    const out = `REVIEW_SUMMARY_START\nfirst draft\nREVIEW_SUMMARY_END\nREVIEW_SUMMARY_START\n${DIGEST}\nREVIEW_SUMMARY_END`;
    expect(extractSummary(out)).toBe(DIGEST);
  });

  test('returns null when there is no digest or it is empty', () => {
    expect(extractSummary('REVIEW_RESULT=NONE')).toBeNull();
    expect(extractSummary('REVIEW_SUMMARY_START\n\nREVIEW_SUMMARY_END')).toBeNull();
    expect(extractSummary('REVIEW_SUMMARY_START\nunterminated digest')).toBeNull();
    expect(extractSummary(undefined)).toBeNull();
  });

  test('truncates a runaway digest instead of failing the Slack post', () => {
    const huge = `#1 ${'x'.repeat(4000)}`;
    const result = extractSummary(`REVIEW_SUMMARY_START\n${huge}\nREVIEW_SUMMARY_END`);
    expect(result.length).toBeLessThan(3000);
    expect(result).toContain('summary truncated');
  });
});

// ─── extractVerdict ───────────────────────────────────────────────────────────

describe('extractVerdict', () => {
  test('reads APPROVE with its reason and maps to a Slack label', () => {
    expect(extractVerdict('REVIEW_VERDICT=APPROVE: no blocking issues found')).toEqual({
      verdict: 'APPROVE',
      reason: 'no blocking issues found',
      label: '✅ Ready to merge',
    });
  });

  test('reads REQUEST_CHANGES', () => {
    expect(extractVerdict('REVIEW_VERDICT=REQUEST_CHANGES: fix the race condition first'))
      .toMatchObject({ verdict: 'REQUEST_CHANGES', label: '🚫 Needs changes' });
  });

  test('reads COMMENT', () => {
    expect(extractVerdict('REVIEW_VERDICT=COMMENT: minor nits only, non-blocking'))
      .toMatchObject({ verdict: 'COMMENT', label: '💬 Reviewed' });
  });

  test('tolerates a missing colon or extra spacing', () => {
    expect(extractVerdict('REVIEW_VERDICT=APPROVE  ready to ship')).toEqual({
      verdict: 'APPROVE',
      reason: 'ready to ship',
      label: '✅ Ready to merge',
    });
  });

  test('reason is null when the run gave none', () => {
    expect(extractVerdict('REVIEW_VERDICT=APPROVE')).toMatchObject({ verdict: 'APPROVE', reason: null });
    expect(extractVerdict('REVIEW_VERDICT=APPROVE:')).toMatchObject({ reason: null });
  });

  test('uses the last marker when several appear', () => {
    expect(extractVerdict('REVIEW_VERDICT=COMMENT: draft\nREVIEW_VERDICT=APPROVE: final'))
      .toMatchObject({ verdict: 'APPROVE', reason: 'final' });
  });

  test('returns null when the run reported no verdict', () => {
    expect(extractVerdict('just a review, no marker')).toBeNull();
    expect(extractVerdict('REVIEW_VERDICT=MAYBE: unknown enum value')).toBeNull();
    expect(extractVerdict('')).toBeNull();
    expect(extractVerdict(undefined)).toBeNull();
  });
});

// ─── HEADLESS_POLICY ──────────────────────────────────────────────────────────

describe('HEADLESS_POLICY', () => {
  test('selects every severity, not just high/medium', () => {
    expect(HEADLESS_POLICY).toContain('`post all`');
    expect(HEADLESS_POLICY).toContain('🔵 Low');
    expect(HEADLESS_POLICY).not.toMatch(/Never post/);
  });

  test('asks for all four machine-readable blocks', () => {
    expect(HEADLESS_POLICY).toContain('REVIEW_COUNTS=');
    expect(HEADLESS_POLICY).toContain('REVIEW_VERDICT=');
    expect(HEADLESS_POLICY).toContain('REVIEW_SUMMARY_START');
    expect(HEADLESS_POLICY).toContain('REVIEW_SUMMARY_END');
    expect(HEADLESS_POLICY).toContain('REVIEW_RESULT=');
  });

  test('clarifies the verdict is advisory, never an actual GitHub approval', () => {
    expect(HEADLESS_POLICY).toContain('This never approves the PR on GitHub');
  });

  test('specifies the P1/P2/P3 digest shape and Slack mrkdwn', () => {
    expect(HEADLESS_POLICY).toContain('P1 — Must verify before ship');
    expect(HEADLESS_POLICY).toContain('P2 — Should fix');
    expect(HEADLESS_POLICY).toContain('Key findings (<total> total)');
    expect(HEADLESS_POLICY).toMatch(/Slack mrkdwn/);
  });
});

// ─── runPrReview ──────────────────────────────────────────────────────────────

describe('runPrReview', () => {
  test('spawns claude with /review-pr in the repo clone and returns the comment URL', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);

    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('/review-pr 18647');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(opts.cwd).toBe(path.join(REPO_ROOT, 'everfit-api'));

    child.stdout.emit('data', [
      'done',
      'REVIEW_COUNTS=high=2,medium=3,low=1',
      'REVIEW_VERDICT=REQUEST_CHANGES: fix the high-severity issue first',
      'REVIEW_SUMMARY_START',
      DIGEST,
      'REVIEW_SUMMARY_END',
      `REVIEW_RESULT=${PR_URL}#issuecomment-5350479923`,
    ].join('\n'));
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({
      ok: true,
      commentUrl: `${PR_URL}#issuecomment-5350479923`,
      counts: { high: 2, medium: 3, low: 1 },
      summary: DIGEST,
      verdict: { verdict: 'REQUEST_CHANGES', reason: 'fix the high-severity issue first', label: '🚫 Needs changes' },
    });
  });

  test('ok with commentUrl null when nothing was posted', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    child.stdout.emit('data', 'no findings\nREVIEW_COUNTS=high=0,medium=0,low=0\nREVIEW_RESULT=NONE');
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ ok: true, commentUrl: null });
  });

  test('counts is null when the run did not report them', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    child.stdout.emit('data', `REVIEW_RESULT=${PR_URL}#issuecomment-1`);
    child.emit('close', 0);

    await expect(promise).resolves.toMatchObject({ ok: true, counts: null });
  });

  test('honours CLAUDE_BIN, REVIEW_PERMISSION_MODE and REVIEW_CLAUDE_MODEL', async () => {
    process.env.CLAUDE_BIN = '/opt/homebrew/bin/claude';
    process.env.REVIEW_PERMISSION_MODE = 'acceptEdits';
    process.env.REVIEW_CLAUDE_MODEL = 'opus';
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('/opt/homebrew/bin/claude');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');

    child.emit('close', 0);
    await promise;
  });

  test('fails without spawning when the repo has no local clone', async () => {
    fs.existsSync.mockReturnValue(false);
    const result = await runPrReview('https://github.com/Everfit-io/other-repo/pull/5');
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no local clone for "other-repo"/);
  });

  test('fails without spawning when the repo is outside REVIEW_ALLOWED_REPOS', async () => {
    process.env.REVIEW_ALLOWED_REPOS = 'file-service';
    const result = await runPrReview(PR_URL); // everfit-api
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/"everfit-api" is not in REVIEW_ALLOWED_REPOS/);
  });

  test('fails for a non-PR URL', async () => {
    const result = await runPrReview('https://github.com/Everfit-io/everfit-api');
    expect(spawn).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  test('reports a non-zero exit with the stderr tail', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    child.stderr.emit('data', 'gh: PR not found');
    child.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/claude exited 1: gh: PR not found/);
  });

  test('reports spawn errors (e.g. claude not on PATH)', async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    child.emit('error', new Error('spawn claude ENOENT'));

    await expect(promise).resolves.toMatchObject({ ok: false, error: 'spawn claude ENOENT' });
  });

  test('kills the run and reports a timeout past REVIEW_TIMEOUT_MINUTES', async () => {
    jest.useFakeTimers();
    process.env.REVIEW_TIMEOUT_MINUTES = '1';
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const promise = runPrReview(PR_URL);
    jest.advanceTimersByTime(61 * 1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 1 min/);

    jest.useRealTimers();
    delete process.env.REVIEW_TIMEOUT_MINUTES;
  });
});
