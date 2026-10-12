'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RESULT_MARKER = 'REVIEW_RESULT=';
const COUNTS_MARKER = 'REVIEW_COUNTS=';
const VERDICT_MARKER = 'REVIEW_VERDICT=';
const SUMMARY_START = 'REVIEW_SUMMARY_START';
const SUMMARY_END = 'REVIEW_SUMMARY_END';

// Boilerplate that the local `claude` CLI/session machinery can print or fail on —
// unrelated to whether the review itself worked, but noisy enough to push the
// actual error out of the 500-char stderr tail we report. Stripped before truncating.
const NOISE_LINE_PATTERNS = [
  /^Warning: no stdin data received/,
  /^SessionEnd hook \[.*\] failed:/,
];

/**
 * Drops known-noisy boilerplate lines (hook warnings, stdin prompts) from CLI
 * output before it's truncated for a Slack-facing error message.
 *
 * @param {string} text
 * @returns {string}
 */
function stripNoise(text) {
  return String(text || '')
    .split('\n')
    .filter(line => !NOISE_LINE_PATTERNS.some(re => re.test(line.trim())))
    .join('\n');
}

// PR URL → the currently running review's cancel handle, so a "Cancel review"
// click can find and kill the right `claude` process. Populated once the
// process actually spawns, cleared as soon as it closes (cancelled or not).
const activeReviews = new Map();

/**
 * Kills the in-progress review for a PR, if one is actually running.
 * Best-effort: anything the run already posted to GitHub before the kill
 * stays posted — this only stops further work, it doesn't undo output.
 *
 * @param {string} prUrl
 * @returns {boolean} true if a running process was found and killed
 */
function cancelReview(prUrl) {
  const entry = activeReviews.get(prUrl);
  if (!entry) return false;
  entry.cancel();
  return true;
}

/**
 * Extra system prompt handed to the headless Claude Code run. The review-pr skill
 * is interactive by design (Phase C previews, then waits for a finding selection),
 * so this states the selection up front and asks for machine-parseable last lines.
 */
const HEADLESS_POLICY = [
  'You are running non-interactively from a Slack bot. No human can answer questions or confirm anything — never stop to ask.',
  'Review only the PR named in the command. Other PRs mentioned in its description or discussion (e.g. a related change in another repo) are context: you may read them (`gh pr view`, `gh pr diff`) to understand dependencies and deploy order, but never review them and never post anything on them.',
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

// Repos whose PRs implement a written solution design that lives in another repo.
// Keyed by the reviewed repo's name; the review is told where to look so it can
// check the PR against the intended design, not just against the diff itself.
const DESIGN_DOC_SOURCES = {
  'everfit-microservices': { repo: 'Everfit-io/mp-foundry', dir: 'projects' },
};

/**
 * Extra system-prompt section telling the review to find and use the solution
 * design for this PR. Empty for repos with no configured design-doc source.
 *
 * The project folders are named `<jira-key>-<slug>` (e.g. `mpd-817-texting-concierge-pilot`)
 * and hold their designs under `docs/`, so the run matches the folder on the PR's
 * Jira key / title / branch and reads `*solution-design*` files from it.
 *
 * @param {{repo: string, number: string}} pr
 * @returns {string}
 */
function designDocPolicy(pr) {
  const source = DESIGN_DOC_SOURCES[pr.repo];
  if (!source) return '';
  const { repo, dir } = source;
  return [
    `Solution design lookup (do this before Phase A, read-only): this PR implements a design documented in the \`${repo}\` GitHub repo under \`${dir}/\`.`,
    `1. Get the PR's Jira key, title, branch and description: \`gh pr view ${pr.number} --json title,body,headRefName\`.`,
    `2. List the project folders: \`gh api repos/${repo}/contents/${dir} --jq '.[].name'\`. Folders are named \`<jira-key>-<slug>\` in lowercase (e.g. \`mpd-817-texting-concierge-pilot\`) — pick the one matching the PR's Jira key, otherwise the clearest match on slug vs. title/branch/description. Never guess between ambiguous candidates.`,
    `3. List \`${dir}/<folder>/docs\` and read the file(s) with \`solution-design\` in the name (if several, read the newest by date prefix, e.g. \`2026-10-09-solution-design-….md\`): \`gh api repos/${repo}/contents/<path> -H 'Accept: application/vnd.github.raw'\`. Authentication comes from GITHUB_TOKEN in the environment.`,
    '4. Use the design as the baseline for the review: report where the PR contradicts it, leaves a designed part of this change out, or adds behavior the design does not cover. Treat the design as intent, not as gospel — if the code is clearly right and the doc is stale, say so rather than flagging the code. Cite the doc section when you raise such a finding.',
    `5. Put a one-line "Solution design: <link to the doc>" at the top of the review comment you post. If no matching design exists or it cannot be fetched, say "Solution design: not found" in that same place, and review the diff on its own — never invent a design and never stop the review over this.`,
    `Only read from \`${repo}\`; never write to it.`,
  ].join('\n');
}

// Repos that ship their own review methodology, as paths inside the repo's clone
// (the run's cwd). The global review-pr skill still does the PR plumbing — fetch
// the diff, post the comment — but the analysis follows the repo's own skill.
const REPO_REVIEW_SKILLS = {
  'client-payment-api': {
    skill: '.claude/skills/review/SKILL.md',
    rules: '.claude/agents/code-reviewer.md',
  },
};

/**
 * Extra system-prompt section telling the review to follow the repo's own review
 * skill. Empty for repos with none configured.
 *
 * That skill is written for a working tree (`git diff`, then `npm run build/test/lint`)
 * and reports CRITICAL/HIGH/MEDIUM/LOW with an APPROVE/REQUEST_CHANGES/NEEDS_DISCUSSION
 * verdict, while this bot reviews a PR (the clone may sit on any branch) and parses
 * High/Medium/Low + APPROVE/REQUEST_CHANGES/COMMENT — so the policy translates both.
 *
 * @param {{repo: string, number: string}} pr
 * @returns {string}
 */
function repoReviewPolicy(pr) {
  const source = REPO_REVIEW_SKILLS[pr.repo];
  if (!source) return '';
  const { skill, rules } = source;
  return [
    `Repo review methodology: \`${pr.repo}\` has its own review skill at \`${skill}\` (checklists under its \`references/\` folder, review rules in \`${rules}\`). Read them from the current directory before Phase A.`,
    `1. Keep using the review-pr skill for everything PR-specific: getting PR #${pr.number}'s diff and metadata (\`gh pr diff\`, \`gh pr view\`) and posting the review. Do not review \`git diff\` of the local checkout — it is not the PR.`,
    `2. Do the analysis the repo skill describes instead of a generic one: Stage 1 spec compliance (against the PR description/ticket), Stage 2 the full quality checklist (every category it lists, plus the base and API checklists), Stage 3 the adversarial pass.`,
    '3. Skip its Step 1 and Step 2 commands (`git status`, `npm run build/test/lint`) — the local clone is not at the PR head. Read changed files through `gh pr diff` or `gh api` at the PR head instead. Never check out another branch, commit, or modify the clone.',
    '4. Severity mapping for everything downstream (counts, digest, posted comment): CRITICAL and HIGH → 🔴 High (P1), MEDIUM → 🟡 Medium (P2), LOW → 🔵 Low (P3). Verdict mapping: APPROVE → APPROVE, REQUEST_CHANGES → REQUEST_CHANGES, NEEDS_DISCUSSION → COMMENT.',
    `5. If \`${skill}\` does not exist in this clone, say nothing about it and review the PR the standard way.`,
  ].join('\n');
}

/**
 * The full `--append-system-prompt` for a run: the repo-specific design lookup
 * and review methodology (if any) first, then the headless policy that ends
 * with the output markers.
 *
 * @param {{repo: string, number: string}} pr
 * @returns {string}
 */
function buildSystemPrompt(pr) {
  return [designDocPolicy(pr), repoReviewPolicy(pr), HEADLESS_POLICY].filter(Boolean).join('\n\n');
}

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

// A real CLI error (e.g. an unaccepted trust dialog) can run several hundred
// chars once it repeats itself across two advisory lines — 500 was cutting the
// actual reason off mid-sentence. Generous but still bounded for the preview post.
const MAX_ERROR_TAIL_CHARS = 2000;

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
 * @param {{model?: string}} [opts] - `--model` for this run; falls back to
 *   REVIEW_CLAUDE_MODEL, then the CLI's own default
 * @returns {Promise<{ok: boolean, commentUrl?: string|null, output?: string, error?: string, repoPath?: string}>}
 */
function runPrReview(prUrl, { model } = {}) {
  const skipReason = reviewSkipReason(prUrl);
  if (skipReason) return Promise.resolve({ ok: false, error: skipReason });

  const pr = parsePrUrl(prUrl);
  const repoPath = resolveRepoPath(pr.repo);

  const bin = process.env.CLAUDE_BIN || 'claude';
  const args = [
    '-p', `/review-pr ${pr.number}`,
    '--append-system-prompt', buildSystemPrompt(pr),
    '--permission-mode', process.env.REVIEW_PERMISSION_MODE || 'bypassPermissions',
  ];
  const reviewModel = model || process.env.REVIEW_CLAUDE_MODEL;
  if (reviewModel) args.push('--model', reviewModel);

  const timeoutMinutes = Number(process.env.REVIEW_TIMEOUT_MINUTES ?? 30);
  console.log(`[Review] running \`${bin} -p "/review-pr ${pr.number}"\` in ${repoPath}`);

  return new Promise(resolve => {
    let child;
    try {
      // stdin is ignored: `claude -p` never reads it, and leaving the pipe open makes
      // the CLI stall ~3s waiting for input before proceeding, on every single run.
      child = spawn(bin, args, { cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: err.message, repoPath });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMinutes * 60 * 1000);

    activeReviews.set(prUrl, {
      cancel: () => {
        cancelled = true;
        child.kill('SIGKILL');
      },
    });

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('error', err => {
      clearTimeout(timer);
      activeReviews.delete(prUrl);
      resolve({ ok: false, error: err.message, repoPath });
    });

    child.on('close', code => {
      clearTimeout(timer);
      activeReviews.delete(prUrl);

      if (cancelled) {
        return resolve({ ok: false, cancelled: true, error: 'cancelled', output: stdout, repoPath });
      }
      if (timedOut) {
        return resolve({ ok: false, error: `review timed out after ${timeoutMinutes} min`, output: stdout, repoPath });
      }
      // A non-zero exit after the model already emitted its final marker block means
      // the review itself completed (and possibly already posted to GitHub) — the
      // failure happened during unrelated session teardown (e.g. a SessionEnd hook),
      // not the review. Treat it as a success rather than discarding real output.
      if (code !== 0 && !stdout.includes(RESULT_MARKER)) {
        const cleaned = stripNoise(stderr || stdout).trim();
        const tail = (cleaned || (stderr || stdout).trim()).slice(-MAX_ERROR_TAIL_CHARS);
        // The Slack-facing error is just the stderr tail — if the model got partway
        // through the review before dying, that stdout transcript is otherwise lost.
        // Logged locally only (never posted to Slack): it can be long and is only
        // useful for debugging at the terminal.
        if (stdout.trim()) {
          console.error(`[Review] PR ${prUrl} exited ${code} with no result marker — stdout was:\n${stdout}`);
        }
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
  cancelReview,
  parsePrUrl,
  resolveRepoPath,
  isRepoAllowed,
  reviewSkipReason,
  extractCommentUrl,
  extractCounts,
  extractSummary,
  extractVerdict,
  HEADLESS_POLICY,
  designDocPolicy,
  repoReviewPolicy,
  buildSystemPrompt,
};
