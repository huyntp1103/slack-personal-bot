'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RESULT_MARKER = 'REVIEW_RESULT=';
const COUNTS_MARKER = 'REVIEW_COUNTS=';
const VERDICT_MARKER = 'REVIEW_VERDICT=';
const SUMMARY_START = 'REVIEW_SUMMARY_START';
const SUMMARY_END = 'REVIEW_SUMMARY_END';

/**
 * Extra system prompt handed to the headless Claude Code run. The review-pr skill
 * is interactive by design (Phase C previews, then waits for a finding selection),
 * so this states the selection up front and asks for machine-parseable last lines.
 */
const HEADLESS_POLICY = [
  'You are running non-interactively from a Slack bot. No human can answer questions or confirm anything — never stop to ask.',
  'For the review-pr skill: after Phase C, treat this as the reviewer\'s explicit selection — `post all`.',
  'Run Phase D with every finding you reported — 🔴 High, 🟡 Medium and 🔵 Low — plus the ✅ Confirmed Safe section.',
  'If the review produced no findings at all, post nothing to GitHub.',
  'End your final reply with these four blocks, in this order, nothing after them:',
  `1. ${COUNTS_MARKER}high=<n>,medium=<n>,low=<n>  — the number of findings you reported at each severity (0 when none).`,
  `2. ${VERDICT_MARKER}<APPROVE|REQUEST_CHANGES|COMMENT>: <one-line reason>  — your Verdict from Phase B, restated as a single machine-parseable line. APPROVE means no High/Medium findings and nothing blocking merge (Low findings and Confirmed Safe items don't block it). This never approves the PR on GitHub — it only tells the human reviewer whether it looks ready.`,
  `3. A Slack-formatted digest of the findings you posted, between a ${SUMMARY_START} line and a ${SUMMARY_END} line, in exactly this shape:`,
  '',
  `${SUMMARY_START}`,
  '*Key findings (<total> total):*',
  '',
  '🔴 *P1 — Must verify before ship*',
  '#<n> <one-line finding — what is wrong, then `→` and the consequence or the fix>',
  '',
  '🟡 *P2 — Should fix*',
  '#<n> <one-line finding>',
  '',
  '🟢 *P3*',
  '#<n> <one-line finding>',
  `${SUMMARY_END}`,
  '',
  'Digest rules: keep the original Phase C finding numbers. Omit a severity heading entirely when it has no findings. One line per finding, ideally under 200 characters — name the symbol/file, not a paragraph. Use Slack mrkdwn (*bold*, `code`), never markdown `**`. Omit the digest marker lines when you posted nothing — the verdict marker still applies (use COMMENT).',
  `4. ${RESULT_MARKER}<url of the comment you posted>, or ${RESULT_MARKER}NONE if you posted nothing.`,
].join('\n');

/**
 * @param {string} prUrl - e.g. https://github.com/Everfit-io/everfit-api/pull/18647
 * @returns {{owner: string, repo: string, number: string}|null}
 */
function parsePrUrl(prUrl) {
  const match = String(prUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

/**
 * Repos the 👀 review is allowed to run on, from REVIEW_ALLOWED_REPOS.
 * Empty list = no restriction (any repo with a local clone).
 *
 * @returns {string[]}
 */
function allowedRepos() {
  return (process.env.REVIEW_ALLOWED_REPOS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} repo - GitHub repo name, e.g. "everfit-api"
 * @returns {boolean}
 */
function isRepoAllowed(repo) {
  const allowed = allowedRepos();
  return allowed.length === 0 || allowed.includes(repo);
}

/**
 * Resolves the local clone for a GitHub repo name: `REVIEW_REPO_ROOT/<repo>`.
 * Returns null when REVIEW_REPO_ROOT is unset or the directory isn't a git repo —
 * the bot then skips the review instead of running Claude in the wrong place.
 *
 * @param {string} repo
 * @returns {string|null}
 */
function resolveRepoPath(repo) {
  const root = process.env.REVIEW_REPO_ROOT;
  if (!root || !repo) return null;
  const repoPath = path.join(root, repo);
  return fs.existsSync(path.join(repoPath, '.git')) ? repoPath : null;
}

/**
 * Why this PR can't be reviewed, or null when it can. Callers check this *before*
 * announcing the review in Slack, so an unreviewable PR never leaves a
 * "starting code review" message with no follow-up.
 *
 * @param {string} prUrl
 * @returns {string|null}
 */
function reviewSkipReason(prUrl) {
  const pr = parsePrUrl(prUrl);
  if (!pr) return `not a GitHub PR URL: ${prUrl}`;

  if (!isRepoAllowed(pr.repo)) {
    return `"${pr.repo}" is not in REVIEW_ALLOWED_REPOS (${allowedRepos().join(', ')})`;
  }
  if (!resolveRepoPath(pr.repo)) {
    return `no local clone for "${pr.repo}" (REVIEW_REPO_ROOT=${process.env.REVIEW_REPO_ROOT || 'unset'})`;
  }
  return null;
}

/**
 * Pulls the posted comment URL out of the Claude run's stdout — the REVIEW_RESULT
 * marker first, then any GitHub comment/review anchor as a fallback.
 *
 * @param {string} output
 * @returns {string|null} null when nothing was posted
 */
function extractCommentUrl(output) {
  const text = String(output || '');

  const markers = [...text.matchAll(new RegExp(`${RESULT_MARKER}(\\S+)`, 'g'))];
  if (markers.length) {
    const value = markers[markers.length - 1][1].replace(/[).,`*]+$/, '');
    return /^https?:\/\//.test(value) ? value : null; // NONE / anything non-URL → nothing posted
  }

  const anchors = text.match(/https:\/\/github\.com\/\S*#(?:issuecomment|pullrequestreview|discussion_r)[-_]?\d+/g);
  return anchors ? anchors[anchors.length - 1].replace(/[).,`*]+$/, '') : null;
}

/**
 * Reads the REVIEW_COUNTS marker (`high=2,medium=3,low=1`) out of the run's stdout.
 *
 * @param {string} output
 * @returns {{high: number, medium: number, low: number}|null} null when the run
 *   didn't report counts — callers then omit the summary rather than claim zeros.
 */
function extractCounts(output) {
  const lines = [...String(output || '').matchAll(new RegExp(`${COUNTS_MARKER}(.+)`, 'g'))];
  if (!lines.length) return null;

  const spec = lines[lines.length - 1][1];
  const read = severity => {
    const match = spec.match(new RegExp(`${severity}\\s*=\\s*(\\d+)`, 'i'));
    return match ? Number(match[1]) : null;
  };

  const counts = { high: read('high'), medium: read('medium'), low: read('low') };
  if (Object.values(counts).every(n => n === null)) return null;

  // A severity the run omitted means it reported none at that level.
  return { high: counts.high ?? 0, medium: counts.medium ?? 0, low: counts.low ?? 0 };
}

const VERDICT_LABELS = {
  APPROVE: '✅ Ready to merge',
  REQUEST_CHANGES: '🚫 Needs changes',
  COMMENT: '💬 Reviewed',
};

/**
 * Reads the REVIEW_VERDICT marker (`APPROVE: no blocking issues found`) out of the
 * run's stdout. `label` is a human-facing badge for Slack — this never approves
 * the PR on GitHub, it only signals whether the run thinks it's ready so a
 * teammate can approve it manually.
 *
 * @param {string} output
 * @returns {{verdict: 'APPROVE'|'REQUEST_CHANGES'|'COMMENT', reason: string|null, label: string}|null}
 *   null when the run reported no verdict.
 */
function extractVerdict(output) {
  const matches = [...String(output || '').matchAll(
    new RegExp(`${VERDICT_MARKER}(APPROVE|REQUEST_CHANGES|COMMENT)\\s*:?\\s*(.*)`, 'g')
  )];
  if (!matches.length) return null;

  const [, verdict, rawReason] = matches[matches.length - 1];
  const reason = rawReason.trim().replace(/[`*_]+$/, '') || null;

  return { verdict, reason, label: VERDICT_LABELS[verdict] };
}

// Slack rejects messages over 40k chars; keep the digest well under that.
const MAX_SUMMARY_CHARS = 2800;

/**
 * Pulls the Slack-formatted findings digest out of the run's stdout — the text
 * between the REVIEW_SUMMARY_START / REVIEW_SUMMARY_END markers.
 *
 * @param {string} output
 * @returns {string|null} null when the run emitted no digest
 */
function extractSummary(output) {
  // Tolerate the model wrapping the markers in backticks/bold/quote prefixes.
  const decorated = marker => `^[ \\t>*_\`]*${marker}[ \\t>*_\`]*$`;
  const blocks = [...String(output || '').matchAll(
    new RegExp(`${decorated(SUMMARY_START)}([\\s\\S]*?)${decorated(SUMMARY_END)}`, 'gm')
  )];
  if (!blocks.length) return null;

  const body = blocks[blocks.length - 1][1].trim();
  if (!body) return null;

  return body.length > MAX_SUMMARY_CHARS
    ? `${body.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n_…summary truncated — see the full review on GitHub._`
    : body;
}

/**
 * Runs `claude -p "/review-pr <number>"` inside the PR's local clone. Resolves
 * (never rejects) so the Slack handler can always report an outcome.
 *
 * @param {string} prUrl
 * @returns {Promise<{ok: boolean, commentUrl?: string|null, output?: string, error?: string, repoPath?: string}>}
 */
function runPrReview(prUrl) {
  const skipReason = reviewSkipReason(prUrl);
  if (skipReason) return Promise.resolve({ ok: false, error: skipReason });

  const pr = parsePrUrl(prUrl);
  const repoPath = resolveRepoPath(pr.repo);

  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p', `/review-pr ${pr.number}`,
    '--append-system-prompt', HEADLESS_POLICY,
    '--permission-mode', process.env.REVIEW_PERMISSION_MODE || 'bypassPermissions',
  ];
  if (process.env.REVIEW_CLAUDE_MODEL) args.push('--model', process.env.REVIEW_CLAUDE_MODEL);

  const timeoutMinutes = Number(process.env.REVIEW_TIMEOUT_MINUTES ?? 30);
  console.log(`[Review] running \`${bin} -p "/review-pr ${pr.number}"\` in ${repoPath}`);

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, { cwd: repoPath, env: process.env });
    } catch (err) {
      return resolve({ ok: false, error: err.message, repoPath });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMinutes * 60 * 1000);

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, repoPath });
    });

    child.on('close', code => {
      clearTimeout(timer);

      if (timedOut) {
        return resolve({ ok: false, error: `review timed out after ${timeoutMinutes} min`, output: stdout, repoPath });
      }
      if (code !== 0) {
        const tail = (stderr || stdout).trim().slice(-500);
        return resolve({ ok: false, error: `claude exited ${code}: ${tail}`, output: stdout, repoPath });
      }
      resolve({
        ok: true,
        commentUrl: extractCommentUrl(stdout),
        counts: extractCounts(stdout),
        summary: extractSummary(stdout),
        verdict: extractVerdict(stdout),
        output: stdout,
        repoPath,
      });
    });
  });
}

module.exports = {
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
};
