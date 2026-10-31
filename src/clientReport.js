'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { resolveRepoPath } = require('./review');

// Repo whose `client-report` skill (.claude/skills/client-report/SKILL.md) the 👀
// reaction in the client-report channels runs. Cloned under REVIEW_REPO_ROOT.
const CLIENT_REPORT_REPO = 'everfit-api';
const SKILL_PATH = path.join('.claude', 'skills', 'client-report', 'SKILL.md');

const SUMMARY_START = 'CLIENT_REPORT_SUMMARY_START';
const SUMMARY_END = 'CLIENT_REPORT_SUMMARY_END';

const MAX_ERROR_TAIL_CHARS = 2000;
// Slack caps an ephemeral message well above this; stay comfortably under it.
const MAX_SUMMARY_CHARS = 2800;

/**
 * Extra system prompt for the headless run. The skill is written for an
 * interactive session (it may ask to confirm or for a missing mode), so this
 * pins the mode, forbids questions and asks for a Vietnamese Slack digest in
 * machine-parseable markers.
 */
const HEADLESS_POLICY = [
  'You are running non-interactively from a Slack bot. No human can answer questions or confirm anything — never stop to ask.',
  'Run the client-report skill in `investigate` mode on the Slack thread given in the command, even if the thread looks resolved. Make reasonable assumptions and state them in the saved note instead of asking.',
  'If something blocks the investigation (Slack fetch failure, missing Datadog access, ...), carry on with what you can and say plainly what is missing — never invent a root cause.',
  `End your final reply with a summary written in Vietnamese, in Slack mrkdwn (*bold*, \`code\`, never markdown \`**\`), between a ${SUMMARY_START} line and a ${SUMMARY_END} line, nothing after it, in exactly this shape:`,
  '',
  SUMMARY_START,
  '*Báo cáo khách hàng — <tiêu đề ngắn của sự cố>*',
  '*Triệu chứng:* <1–2 câu>',
  '*Nguyên nhân (kết luận):* <nguyên nhân gốc kèm `path:line`, hoặc "Chưa đủ thông tin" nếu chưa kết luận>',
  '*Trạng thái:* <status của ghi chú, ví dụ NEEDS MORE INFO / MATCHES KNOWN ISSUE / ...>',
  '*Bước tiếp theo:* <việc nên làm tiếp>',
  '*File đã lưu:* `<đường dẫn ghi chú đã lưu>`',
  SUMMARY_END,
].join('\n');

// Prompt prefix for a follow-up. The reviewer's hint is usually a question, so
// the digest must answer it first instead of restating the whole report.
const FOLLOW_UP_PREFIX = [
  'Follow-up from the reviewer — continue the same investigation and answer their message below.',
  'Update the saved note with what you find (add a section for this question; keep earlier findings unless they were wrong).',
  'End with the summary block again, but make it about THIS message: start with a line `*Trả lời:* <direct answer to the reviewer\'s question in 1–3 sentences, with evidence such as `path:line` or the Datadog/DB fact it rests on, and say plainly if it is still unknown>`, then a line `*Cập nhật ghi chú:* <what you added or changed in the saved note>`, then the usual fields kept short — only restate the cause/status when they changed.',
  'Reviewer message:',
  '',
].join('\n');

// The claude session id rides along in the bot's reply (`🧵 session \`<uuid>\``)
// so a hint written in that thread can resume the same investigation — even
// after the bot restarted, since nothing is kept in memory.
// Slack hands unicode emoji back as `:shortcode:` in a message's text, so the
// marker is matched in either form.
const SESSION_LINE_RE = /(?:🧵|:thread:) session `([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`/;

/** Footer line carrying the session id, appended to every summary reply. */
function sessionLine(sessionId) {
  return `🧵 session \`${sessionId}\``;
}

/**
 * The session id of the most recent investigation in a thread, read back from
 * the bot's own replies. null when none carries one.
 *
 * @param {Array<{text?: string}>} messages - thread messages, oldest first
 * @returns {string|null}
 */
function extractSessionId(messages) {
  for (const m of [...(messages || [])].reverse()) {
    const match = SESSION_LINE_RE.exec(m?.text || '');
    if (match) return match[1];
  }
  return null;
}

const NOTE_PATH_RE = /ai-agents-output\/client-reports-checking\/[^\s`'"<>|*]+?\.md/g;

/**
 * Every saved-note path (`ai-agents-output/client-reports-checking/...md`) the
 * thread's replies mention — the summary's "File đã lưu" line — oldest first,
 * deduped. The root (a copy of the client's message) is never scanned.
 *
 * @param {object[]} messages - thread messages, root first
 * @returns {string[]} repo-relative paths
 */
function extractNotePaths(messages) {
  const found = [];
  for (const m of (messages || []).slice(1)) {
    for (const match of String(m?.text || '').matchAll(NOTE_PATH_RE)) {
      if (!found.includes(match[0])) found.push(match[0]);
    }
  }
  return found;
}

/**
 * Deletes a note the skill saved in the everfit-api clone. Only paths under
 * `ai-agents-output/client-reports-checking/` that resolve inside that folder
 * are touched (the path came out of a Slack message, so it is not trusted).
 *
 * @param {string} relPath - repo-relative path from `extractNotePaths`
 * @returns {{ok: boolean, missing?: boolean, error?: string}}
 */
function deleteClientReportNote(relPath) {
  const repoPath = resolveRepoPath(CLIENT_REPORT_REPO);
  if (!repoPath) return { ok: false, error: `no local clone for "${CLIENT_REPORT_REPO}"` };

  const notesDir = path.resolve(repoPath, 'ai-agents-output', 'client-reports-checking');
  const full = path.resolve(repoPath, relPath);
  if (!full.startsWith(notesDir + path.sep) || !full.endsWith('.md')) {
    return { ok: false, error: `refusing to delete outside client-reports-checking: ${relPath}` };
  }
  try {
    fs.unlinkSync(full);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, missing: true };
    return { ok: false, error: err.message };
  }
}

/**
 * Pulls the Vietnamese digest out of the run's stdout — the text between the
 * markers. Tolerates the model wrapping the marker lines in backticks/bold.
 *
 * @param {string} output
 * @returns {string|null} null when the run emitted no digest
 */
function extractClientReportSummary(output) {
  const decorated = marker => `^[ \\t>*_\`]*${marker}[ \\t>*_\`]*$`;
  const blocks = [...String(output || '').matchAll(
    new RegExp(`${decorated(SUMMARY_START)}([\\s\\S]*?)${decorated(SUMMARY_END)}`, 'gm')
  )];
  if (!blocks.length) return null;

  const body = blocks[blocks.length - 1][1].trim();
  if (!body) return null;

  return body.length > MAX_SUMMARY_CHARS
    ? `${body.slice(0, MAX_SUMMARY_CHARS).trimEnd()}\n_…tóm tắt bị cắt — xem ghi chú đầy đủ trong repo._`
    : body;
}

/**
 * Why the client-report skill can't run, or null when it can. Checked before
 * spawning so a missing clone/skill is reported instead of failing mid-run.
 *
 * @returns {string|null}
 */
function clientReportSkipReason() {
  const repoPath = resolveRepoPath(CLIENT_REPORT_REPO);
  if (!repoPath) {
    return `no local clone for "${CLIENT_REPORT_REPO}" (REVIEW_REPO_ROOT=${process.env.REVIEW_REPO_ROOT || 'unset'})`;
  }
  if (!fs.existsSync(path.join(repoPath, SKILL_PATH))) {
    return `client-report skill not found at ${path.join(repoPath, SKILL_PATH)}`;
  }
  return null;
}

/**
 * Runs the client-report skill inside the everfit-api clone. Resolves (never
 * rejects) so the Slack handler can always report an outcome.
 *
 * - first run: `claude -p "/client-report investigate <slackUrl>"` under a fresh
 *   `--session-id`
 * - `hint` only: the same command with the hint appended as symptom text (the
 *   skill accepts URL + description) — used when no earlier session is known
 * - `hint` + `resumeSessionId`: `claude -p "<follow-up>" --resume <id>` — the same
 *   session continues with everything it already traced
 *
 * @param {string} slackUrl - archive permalink of the thread's root message
 * @param {{model?: string, hint?: string, resumeSessionId?: string}} [opts]
 * @returns {Promise<{ok: boolean, summary?: string|null, sessionId?: string, output?: string, error?: string}>}
 */
function runClientReport(slackUrl, { model, hint, resumeSessionId } = {}) {
  const skipReason = clientReportSkipReason();
  if (skipReason) return Promise.resolve({ ok: false, error: skipReason });

  const repoPath = resolveRepoPath(CLIENT_REPORT_REPO);
  const bin = process.env.CLAUDE_BIN || 'claude';
  const resuming = Boolean(hint && resumeSessionId);
  const sessionId = resuming ? resumeSessionId : randomUUID();
  const prompt = resuming
    ? `${FOLLOW_UP_PREFIX}${hint}`
    : `/client-report investigate ${slackUrl}${hint ? ` ${hint}` : ''}`;
  const args = [
    '-p', prompt,
    resuming ? '--resume' : '--session-id', sessionId,
    '--append-system-prompt', HEADLESS_POLICY,
    '--permission-mode', process.env.REVIEW_PERMISSION_MODE || 'bypassPermissions',
  ];
  const reportModel = model || process.env.REVIEW_CLAUDE_MODEL;
  if (reportModel) args.push('--model', reportModel);

  const timeoutMinutes = Number(process.env.REVIEW_TIMEOUT_MINUTES ?? 30);
  console.log(`[ClientReport] ${resuming ? `resuming session ${sessionId}` : 'starting'} for ${slackUrl} in ${repoPath}`);

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, { cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
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
      resolve({ ok: false, error: err.message });
    });

    child.on('close', code => {
      clearTimeout(timer);

      if (timedOut) {
        return resolve({ ok: false, error: `client report timed out after ${timeoutMinutes} min`, output: stdout });
      }
      // A non-zero exit after the digest was emitted came from session teardown
      // (e.g. a SessionEnd hook), not the investigation — keep the real output.
      if (code !== 0 && !stdout.includes(SUMMARY_END)) {
        const tail = (stderr || stdout).trim().slice(-MAX_ERROR_TAIL_CHARS);
        return resolve({ ok: false, error: `claude exited ${code}: ${tail}`, output: stdout });
      }
      resolve({ ok: true, summary: extractClientReportSummary(stdout), sessionId, output: stdout });
    });
  });
}

module.exports = {
  runClientReport,
  clientReportSkipReason,
  extractClientReportSummary,
  extractSessionId,
  extractNotePaths,
  deleteClientReportNote,
  sessionLine,
  HEADLESS_POLICY,
  FOLLOW_UP_PREFIX,
  CLIENT_REPORT_REPO,
};
