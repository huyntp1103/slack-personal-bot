# GitHub → Jira → Slack Automation Bot

Personal automation bot that eliminates manual Jira transitions and Slack notifications during the PR lifecycle. Because team GitHub repos block webhook configuration, all event detection is done via **Slack events** and a **local git hook**.

## Stack

- **Runtime**: Node.js + Express.js
- **Jira**: `jira.js` (Version2Client)
- **Slack**: `@slack/web-api` + Slack Events API
- **GitHub**: Native `fetch` → GitHub REST API (PR title + base branch)
- **Testing**: Jest + Supertest
- **Deployment**: Railway / Render

## Project Structure

```text
/
├── src/
│   ├── index.js          # Express server — routes for Slack events + git hook
│   ├── jira.js           # Jira transition + comment helpers
│   ├── slack.js          # Slack postMessage + fetchMessage helpers
│   ├── github.js         # GitHub PR data fetcher (title, base branch, commits)
│   ├── review.js         # Headless `claude -p "/review-pr <n>"` runner (👀 reaction)
│   └── utils.js          # extractJiraKey(), extractAllJiraKeys(), extractSlackThread()
├── hooks/
│   └── post-push         # Local git hook script (symlinked into repos)
├── tests/
│   ├── utils.test.js
│   ├── github.test.js
│   ├── jira.test.js
│   ├── slack.test.js
│   ├── review.test.js
│   └── index.test.js
├── .env.example
├── package.json
└── CLAUDE.md
```

## Event Sources & Trigger Logic

| Event | Source | Condition | Jira Action |
| --- | --- | --- | --- |
| `git push` (new branch) | Local git `post-push` hook | Branch has no upstream yet | → In Progress |
| New message in `#backend-review-code` | Slack `message` event | Root message (not reply), from `MY_SLACK_USER_ID`, contains a PR link | → In Review |
| ✅ reaction on **my own** message in `#backend-review-code` | Slack `reaction_added` event | Reaction by `MY_SLACK_USER_ID`, `item_user === MY_SLACK_USER_ID`, PR base branch in `develop`, `releasing_staging`, `main`, `master` | → QA Ready (always) + comment + Slack thread reply (only when base is `develop` or `releasing_staging`) |
| ✅ reaction on a **teammate's** message in `#backend-review-code` | Slack `reaction_added` event | Reaction by `MY_SLACK_USER_ID`, `item_user !== MY_SLACK_USER_ID`, message contains ≥1 GitHub PR link | Approves each PR via GitHub `POST /pulls/:n/reviews` (event `APPROVE`). Ignores `DRY_RUN`. |
| 👀 reaction on any message in `#backend-review-code` | Slack `reaction_added` event | Reaction by `MY_SLACK_USER_ID`, root message, contains ≥1 GitHub PR link | Runs `claude -p "/review-pr <n>"` in `REVIEW_REPO_ROOT/<repo>`. Auto-posts **all** findings (High + Medium + Low + Confirmed Safe) to the PR, then replies in the Slack thread with the comment URL and a per-severity count. **Approves the PR on GitHub** when the run's verdict is `APPROVE` or it found nothing to post. No Jira action. Ignores `DRY_RUN` for the GitHub post. The "Starting code review..." reply carries a `Cancel review of #<n>` button (see below); when findings are left open, the completion reply carries a `🔍 Review #<n> again` button (see below). |
| Click on `Cancel review of #<n>` button | Slack `block_actions` interaction → `POST /slack/interactive` | `MY_SLACK_USER_ID` only; PR must actually be under review | Kills the running `claude` process for that PR and replies in the thread that it was cancelled. No Jira action, no GitHub post. |
| Click on `🔍 Review #<n> again` button | Slack `block_actions` interaction → `POST /slack/interactive` | Any user; capped at `MAX_TEAMMATE_REVIEWS` (2) uses per PR for everyone except `MY_SLACK_USER_ID` (unlimited) | Re-runs the 👀 review flow for that PR in the same thread. No Jira action. |
| `/tickets [YYYY-MM-DD]` (Slack slash command) → `POST /slack/commands` | Slack slash command, only responds to `MY_SLACK_USER_ID` | Optional date arg (default: today in Asia/Bangkok) | Searches every message **you** posted that day (workspace-wide via `search.messages`, no need for the bot to be in the channel), extracts Jira keys, groups by channel. Reply is ephemeral. |
| `GET /jira/tickets-by-day?date=YYYY-MM-DD` | Direct HTTP call (curl / dev shortcut) | Optional `date` query (default: today) | Same audit as the slash command — JSON response, posts a preview-channel summary too |

## Jira Key Format

Extracted from PR title or commit message using `/[A-Z]+-\d+/`.

Example: `feat(similar-weight-rep): UP-68162 get max weight in many reps matched` → `UP-68162`

Jira key is first looked up in Slack message text, then falls back to fetching the GitHub PR title via the API.

Jira base URL: `https://everfit.atlassian.net/browse/<KEY>`

## Transition Guard Rules

| Target Status | Required Current Status | Extra Condition |
| --- | --- | --- |
| In Progress | To Do | Ticket must NOT be in sprint id `249` (Active Sprint Backlog) |
| In Review | In Progress | A worklog is created automatically before the transition (Scrum Master rule) |
| QA Ready | In Review | PR base branch must be in `develop`, `releasing_staging`, `main`, `master` |

`transitionIssue()` returns `false` when skipped — callers (comment, Slack reply) must check the return value before proceeding.

## Slack Event Filtering Rules

- **`message` event** (In Review trigger):
  - Channel: `SLACK_REVIEW_CHANNEL`
  - User: `MY_SLACK_USER_ID`
  - Must be a **root message** (`thread_ts` absent or equals `ts`)
  - Message must contain a GitHub PR link
  - Slack wraps URLs as `<https://...>` — stripped before matching

- **`reaction_added` event — `:white_check_mark:`** (single emoji, two flows — routed by `event.item_user`):
  - Shared filters: `event.user === MY_SLACK_USER_ID`, `event.item.type === 'message'`, channel `SLACK_REVIEW_CHANNEL`.
  - `event.item_user === MY_SLACK_USER_ID` → **QA Ready flow** (`handleReactionAdded`):
    - PR base branch must be one of `develop`, `releasing_staging`, `main`, `master`.
    - **`releasing_staging` PRs**: contain commits from many people, so the bot fetches the PR commit list, filters to commits where `MY_GITHUB_USERNAME` is the **author OR committer** (so cherry-picked commits count too), dedupes by Jira key, and processes each ticket independently.
    - **For all other branches**: single ticket extracted from the Slack message text or PR title.
    - **Notification scope**: comment + Slack thread reply only fire for `develop` and `releasing_staging`. For `main`/`master`, the bot transitions the ticket and stops.
  - `event.item_user !== MY_SLACK_USER_ID` → **PR approve flow** (`handleApproveReaction`):
    - If `event.item_user` is in `IGNORED_TEAMMATE` (comma-separated Slack user IDs), the flow is skipped — used to suppress accidental triggers on bots or specific teammates.
    - Extracts every `https://github.com/<owner>/<repo>/pull/<n>` in the teammate's message, dedupes, and calls `approvePr` on each.
    - **Ignores `DRY_RUN`** — approvals always run when this flow triggers.

- **`reaction_added` event — `:eyes:`** (`handleReviewRequestReaction` — Claude Code review):
  - Filters: `event.user === MY_SLACK_USER_ID`, `event.item.type === 'message'`, channel `SLACK_REVIEW_CHANNEL`, reacted item must be a **root message** (fetched `message.ts === event.item.ts`), message must contain ≥1 GitHub PR link.
  - **Not routed by `item_user`** — works on a teammate's message or your own.
  - Per PR, in order:
    1. Thread reply: `Starting code review for PR #<n>. Will post results here shortly.`, carrying a `Cancel review of #<n>` button (see below).
    2. `runPrReview(prUrl)` → spawns `claude -p "/review-pr <n>"` (see below).
    3. Thread reply: `The review is complete; please view it <comment-url|here>.` followed by the **verdict badge** — `*✅ Ready to merge* — <reason>`, `*🚫 Needs changes* — <reason>`, or `*💬 Reviewed* — <reason>` (reason omitted if the run gave none) — then the run's **findings digest**: a `*Key findings (N total):*` block grouped into 🔴 P1 / 🟡 P2 / 🟢 P3 with one line per finding, keeping the Phase C numbers. The URL is wrapped in Slack link syntax so the thread shows a short **here** link, not a raw URL. When the verdict clears the PR the bot **approves it on GitHub** and the badge is replaced by a single `✅ *Approved on GitHub* — <reason> · <comment-url|full review>` line (see **Auto-approval on a clean review**); otherwise the badge is advisory only and a human approves manually. Digest fallbacks, in order: digest → bare counts `(🔴 2 High · 🟡 3 Medium · 🟢 1 Low)` from `REVIEW_COUNTS` → nothing at all (never faked as zeros); the digest/counts recap is skipped entirely when nothing was posted (nothing to recap), but the verdict badge still shows — this is the "all Confirmed Safe, ready to merge" case. When nothing was posted and there's no verdict either: `The review is complete — no findings to post.`
  - **Auto-approval on a clean review**: after a successful run the bot approves the PR on GitHub (`approvePr`, body `✅ Auto-approved after an automated code review — <verdict reason>`) when the outcome clears it — an `APPROVE` verdict, **or** nothing posted (`REVIEW_RESULT=NONE`). A `REQUEST_CHANGES` verdict always blocks the approval, even when nothing was posted. On a successful approval the bot also reacts `:white_check_mark:` (`reactToMessage`) to the **original Slack message that carried the PR link** — the same one that got the 👀 reaction or, for a re-review via the button, the thread root — so the channel can see at a glance that it's done. The approval happens **before** the completion reply, and **replaces** it: instead of `The review is complete…` + the `✅ Ready to merge` badge + an approval line (three ways of saying the same thing), the thread gets one line — `✅ *Approved on GitHub* — <verdict reason, or "no blocking findings."> · <comment-url|full review>` — followed by the digest/counts recap. When nothing was posted there is no link and no recap, so the reply is that single line. Ignores `DRY_RUN` for the GitHub approval itself, like the ✅ teammate approve flow; the `:white_check_mark:` reaction respects `DRY_RUN` the same way `replyToThread` does (previewed, not posted for real). A **failed** approval emits one untagged `⚠️ PR auto-approve failed` preview (with the thread link) and the thread reply simply omits the approval line and skips the reaction — it never claims an approval that didn't happen. If the approval succeeds but the reaction itself fails (e.g. missing `reactions:write` scope), that's surfaced too — an untagged `⚠️ PR approved, but the :white_check_mark: reaction failed` preview with the Slack error code — rather than only a server log no one is watching; the completion reply still shows the approval normally. A successful approval + reaction otherwise emits no preview.
  - **No preview on success.** Both thread replies pass `{ notify: false }` to `replyToThread`, suppressing its per-reply `✅ Replied in Slack` preview — a completed review is silent in `SLACK_PREVIEW_CHANNEL`, the team thread reply is the only output. (Under `DRY_RUN=true` the reply preview still fires, since it's the only output in that mode.)
  - **Repo restriction**: `reviewSkipReason(prUrl)` checks `REVIEW_ALLOWED_REPOS` and the local clone *before* anything is posted to the team thread — a disallowed or unclonable repo gets a single `⏭️ Code review skipped` preview and no "Starting code review" message at all.
  - **Failures** (claude missing, non-zero exit, timeout, no local clone) are reported **only** to `SLACK_PREVIEW_CHANNEL` — nothing further goes into the team thread. The failure preview ends with `<archive-url|Go to thread>` (from `buildThreadLink`) so you can jump straight to the reacted message — omitted when `SLACK_WORKSPACE` is unset.
  - A second 👀 on a PR already under review is ignored (in-flight `Set` keyed by PR URL) so it can't double-post to GitHub.
  - **"Cancel review of #\<n\>" button**: attached (as a red/`danger`-styled Block Kit button, via `cancelReviewBlocks`) to the "Starting code review..." reply for every run. Unlike "Review again", this is **owner-only** — `handleReviewCancelClick` checks `payload.user.id === MY_SLACK_USER_ID` first and gives anyone else an ephemeral `Only <@MY_SLACK_USER_ID> can cancel a review.`, without even checking whether the PR is under review. For the owner, it's guarded next by the same in-flight `Set` (`reviewsInFlight`) the 👀 duplicate-guard uses — a click on a PR that isn't currently under review gets an ephemeral "isn't currently under review — nothing to cancel" and does nothing else. If it is in flight, `cancelReview(prUrl)` (from `src/review.js`) looks up the running `claude` child process by PR URL and sends it `SIGKILL`; `runPrReview`'s promise then resolves `{ ok: false, cancelled: true, error: 'cancelled' }` instead of its usual shape, which `runReviewForPr` checks for and returns early on — no completion reply, no verdict badge, no auto-approval attempt, since the cancel click already announced it (`❌ Review of PR #<n> cancelled by <@user>.`, posted to the thread, not ephemeral, `{ notify: false }`). Cancelling is **best-effort**: anything the run already posted to GitHub before the kill (a comment, a review) stays posted — this only stops further work, it never tries to undo GitHub output. A `cancelReview` call that finds nothing to kill (rare race: clicked between the in-flight check and the process actually spawning, or right as it finishes on its own) gets an ephemeral "Couldn't cancel PR #<n> right now — try again in a moment." instead of a false claim of success.
  - **"🔍 Review #\<n\> again" button**: attached (as a Block Kit button, via `reviewAgainBlocks`) to the completion reply whenever there are open findings to fix — i.e. the run was **not** auto-approved and it posted a `commentUrl`. Omitted when the PR was approved (nothing left to fix) or when the run posted nothing (no findings to re-review). Clicking it re-runs `runReviewForPr` in the same thread — handled by `POST /slack/interactive` (see below) → `handleReviewAgainClick`. Anyone in the channel can click it, not just you — a teammate who just pushed fixes is usually the one who wants the re-review. The only guard is a per-PR budget: everyone **but** you is capped at `MAX_TEAMMATE_REVIEWS` (2) re-review runs; you can click unlimited times. The budget is an in-memory `Map` keyed by PR URL (cleared on restart, not persisted) — a click that would exceed it, or that lands while the same PR is already under review (checked first, so it never costs a teammate their budget), gets an ephemeral reply (via `respondEphemeral`, visible only to the clicker, never posted to the thread) explaining why nothing started, instead of silently doing nothing.

## Slack URL Verification

Slack sends a `url_verification` challenge on first setup. The `/slack/events` endpoint responds with `{ challenge }`.

## Slack Interactivity (Block Kit buttons)

`POST /slack/interactive` receives every Block Kit button click, as a form-encoded `payload` JSON string (Slack's Interactivity request URL, separate from the Events API). Only handles `block_actions` payloads whose clicked action is `review_pr_again` (the `🔍 Review #<n> again` button) or `review_pr_cancel` (the `Cancel review of #<n>` button) — anything else is ignored. Acks within 3 seconds (`res.sendStatus(200)` first, like `/slack/events`) since the re-review itself can take minutes; verifies the Slack signature the same way as `/slack/events`.

## Preview & Dry Run Mode

Every Jira transition, Jira comment, Jira worklog, and Slack thread reply emits a preview line via `preview(text, opts?)` — printed to the terminal as `[PREVIEW] ...` and (if `SLACK_PREVIEW_CHANNEL` is set) posted to that channel. Previews always run regardless of `DRY_RUN`.

By default the preview text is suffixed with `\n<@MY_SLACK_USER_ID>` so you get a Slack ping. Pass `{ tag: false }` to opt out — currently used by the audit report and the PR-approve previews so they don't self-spam.

`replyToThread(channel, ts, text, { notify: false })` suppresses that reply's own `✅ Replied in Slack` preview, for flows that emit one summary preview of their own (the 👀 review flow). The `DRY_RUN` preview is never suppressed.

`DRY_RUN=true` only gates the **Slack thread reply** (`replyToThread`) — when on, the bot still previews the reply but does not post it to the real thread. Jira transitions, comments, and worklogs always execute. PR approvals (`handleApproveReaction`) also ignore `DRY_RUN` (the trigger itself is an explicit ✅ on a teammate's message). The 👀 review flow ignores `DRY_RUN` too: with `DRY_RUN=true` the two thread replies are preview-only, but the review still runs and **still posts findings to GitHub**.

## Environment Variables

| Variable | Description |
| --- | --- |
| `JIRA_HOST` | `https://everfit.atlassian.net` |
| `JIRA_EMAIL` | Your Atlassian account email |
| `JIRA_TOKEN` | API token from id.atlassian.com |
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot User OAuth Token |
| `SLACK_USER_TOKEN` | `xoxp-...` User OAuth Token — needed for `search.messages` (used by `/tickets`). Requires user scope `search:read`. |
| `SLACK_SIGNING_SECRET` | From Slack App → Basic Information |
| `MY_SLACK_USER_ID` | Your Slack member ID (e.g. `U093ZDNQJF3`) |
| `SLACK_REVIEW_CHANNEL` | Channel ID for `#backend-review-code` |
| `MY_GITHUB_USERNAME` | Your GitHub username |
| `GITHUB_TOKEN` | Personal access token (repo scope) for PR API |
| `ID_TO_DO` | Jira transition ID for "To Do" (optional, used in `TRANSITION_NAMES` map) |
| `ID_IN_PROGRESS` | Jira transition ID for "In Progress" |
| `ID_IN_REVIEW` | Jira transition ID for "In Review" |
| `ID_QA_READY` | Jira transition ID for "QA Ready" |
| `ID_QA_FAILED` | Jira transition ID for "QA Failed" (optional) |
| `ID_IN_TEST` | Jira transition ID for "In Test" (optional) |
| `ID_QA_SUCCESS` | Jira transition ID for "QA Success" (optional) |
| `ID_WILL_NOT_FIX` | Jira transition ID for "Will Not Fix" (optional) |
| `QA_NOTIFY_DELAY_MINUTES` | Minutes to wait after QA Ready before commenting/replying (default: 15) |
| `BOT_URL` | Deployed bot URL (used by git hook) |
| `DRY_RUN` | Set `true` to suppress real Slack thread replies (Jira mutations still run) |
| `SLACK_PREVIEW_CHANNEL` | Channel ID where every action preview is posted (always active when set) |
| `SLACK_WORKSPACE` | Workspace subdomain (e.g. `everfit`) — used to build clickable thread links in previews |
| `IGNORED_AUDIT_CHANNELS` | Comma-separated Slack channel IDs to exclude from `/tickets` audit results |
| `IGNORED_TEAMMATE` | Comma-separated Slack user IDs whose messages should be ignored by the ✅ PR-approve flow (e.g. bots or accidental triggers) |
| `REVIEW_REPO_ROOT` | Parent dir holding local clones (e.g. `/Users/<you>/Everfit`). The 👀 review runs in `REVIEW_REPO_ROOT/<repo>`. **Unset → 👀 does nothing.** |
| `CLAUDE_BIN` | Path to the `claude` CLI (default `claude`; set an absolute path when the bot isn't started from a login shell) |
| `REVIEW_PERMISSION_MODE` | Permission mode for the headless review run (default `bypassPermissions`) |
| `REVIEW_CLAUDE_MODEL` | Optional `--model` override for the review run |
| `REVIEW_TIMEOUT_MINUTES` | Hard SIGKILL for a stuck review (default: 30) |
| `REVIEW_ALLOWED_REPOS` | Comma-separated repo names the 👀 review is allowed to run on (e.g. `everfit-api,file-service`). Empty/unset = no restriction — any repo with a local clone. |
| `PORT` | Server port (default: 3000) |

## Key Behaviors

- **Silent mode**: All Slack filters check `MY_SLACK_USER_ID` — other people's messages/reactions are ignored.
- **Jira key extraction**: Regex `/[A-Z]+-\d+/` on message text first, then GitHub PR title as fallback.
- **Slack thread reply**: For Bug-type tickets after a `develop`/`releasing_staging` PR is approved, extracts Slack archive URL from Jira description (`archives/CXXX/pTIMESTAMP`) and replies to that thread. Skipped for `main`/`master` PRs.
- **QA notification delay**: After a ✅ reaction, the bot waits `QA_NOTIFY_DELAY_MINUTES` (default 15) **before** transitioning to QA Ready, then immediately posts the Jira comment and (for Bug tickets) the Slack thread reply. Delaying the transition itself gives QA a buffer before the ticket moves.
- **Auto worklog before In Review (idempotent)**: When transitioning In Progress → In Review, `createWorklog` first calls `GET /issue/<KEY>/worklog` and skips silently if any worklog already exists. Otherwise it `POST`s a 1-hour worklog with `started=<today>T12:00:00.000+0700` (Asia/Bangkok) and comment `[Bot] Implement based on solution design & implementation plan, self-review, self-test`. If the transition status guard skips, no worklog check happens either.
- **PR approval on teammate ✅**: `approvePr` posts an `event: 'APPROVE'` review to GitHub. The preview emits `✅ PR approved` (or `⚠️ PR approve failed`) **without** an owner tag.
- **Claude Code review on 👀 (`src/review.js`)**: `runPrReview(prUrl)` spawns `claude -p "/review-pr <n>"` with `cwd` = `REVIEW_REPO_ROOT/<repo-from-PR-URL>` (skipped unless that dir contains `.git`). Because the `review-pr` skill is interactive by design (Phase C previews, then waits for a finding selection), the headless policy is injected via `--append-system-prompt`: treat `post all` as the reviewer's selection (🔴 High + 🟡 Medium + 🔵 Low + ✅ Confirmed Safe), post nothing when there are no findings at all, and end the reply with four marker blocks — `REVIEW_COUNTS=high=<n>,medium=<n>,low=<n>`, `REVIEW_VERDICT=<APPROVE|REQUEST_CHANGES|COMMENT>: <reason>` (mirroring the skill's own Verdict line; APPROVE means no High/Medium findings — Low findings and Confirmed Safe don't block it), a Slack-mrkdwn findings digest between `REVIEW_SUMMARY_START` / `REVIEW_SUMMARY_END`, and `REVIEW_RESULT=<url>` (or `REVIEW_RESULT=NONE`). The bot parses all four: `extractCommentUrl` falls back to any `#issuecomment-`/`#pullrequestreview-` anchor in stdout; `extractCounts`, `extractVerdict` and `extractSummary` return null when the run reported nothing parseable, so the recap degrades (digest → counts → omitted) instead of showing zeros. `extractVerdict` maps the three enum values to Slack badges (`✅ Ready to merge` / `🚫 Needs changes` / `💬 Reviewed`) — this is advisory text for the team, never an actual GitHub approval. Both marker regexes tolerate the model wrapping them in backticks or bold, and the digest is truncated past 2800 chars so a runaway summary can't fail the Slack post. **This feature only works when the bot runs on the Mac holding the clones** — a Railway/Render deploy has no `claude` CLI and no repo, so `runPrReview` fails fast and only pings the preview channel.

- **Auto-approve after 👀 review**: `shouldAutoApprove(result)` returns true for an `APPROVE` verdict or a run with no `commentUrl`, and false for `REQUEST_CHANGES`. On true the bot calls `approvePr` and `formatApprovedText` renders the whole completion reply as one `✅ *Approved on GitHub* — …` line (plus the digest when findings were posted), replacing the usual completion sentence and verdict badge.
- **Audit report (`/tickets`)**: `auditTicketsByDay` runs `search.messages` with `from:<@USER> on:DATE`, filters out `IGNORED_AUDIT_CHANNELS`, dedupes Jira keys across all matches, and resolves each key's summary via `getIssueSummary`. The report renders one Slack-formatted link per line: `<JIRA_HOST/browse/KEY|KEY>: <summary>`. Posted as ephemeral reply via the slash command's `response_url`; the GET endpoint also posts a `SLACK_PREVIEW_CHANNEL` summary (untagged).
- **Thread link in previews**: When `SLACK_WORKSPACE` is set, the `replyToThread` preview includes a clickable archive URL (`https://<workspace>.slack.com/archives/<channel>/p<ts>`), so you can jump straight to the thread from the preview channel.
- **Root message filter**: `message` events only trigger if `thread_ts` is absent or equals `ts`.
- **Transition guards**: Wrong current status or blocked sprint → skip silently, no comment/Slack reply.
- **All Jira actions appear as your manual work** (personal token, not a bot account).

## Finding Jira Transition IDs

```bash
curl --request GET \
  --url 'https://everfit.atlassian.net/rest/api/2/issue/UP-68162/transitions' \
  --user 'YOUR_EMAIL:YOUR_JIRA_TOKEN'
```

## Local Dev

```bash
cp .env.example .env   # fill in values
npm install
npm run dev            # nodemon src/index.js
npx ngrok http 3000    # expose to Slack Events API
```

## Running Tests

```bash
npm test                                   # full suite
npx jest tests/ --coverage --forceExit     # with a coverage report
```

### Unit tests are the bar — not manual/e2e verification

Every external dependency is mocked at the module boundary: `@slack/web-api` (`jira.test.js`'s `Version2Client`, `slack.test.js`'s `WebClient`), `jira.js` (mocked in `index.test.js`), `child_process.spawn` (`review.test.js`), and `global.fetch` (`github.test.js`, `slack.test.js`'s `respondEphemeral`, `index.test.js`'s `/slack/commands` and `/slack/interactive` response_url posts). Route handlers are exercised through Supertest against the real Express `app` with a real HMAC signature where that matters — nothing here needs network access, a live Slack workspace, real Jira/GitHub credentials, or `ngrok`.

**This means: after implementing or changing anything in `src/`, `npm test` passing — with new/updated tests covering the change — is sufficient to call the work done.** Do not fire real Slack messages, click real GitHub PR buttons, or otherwise manually poke the deployed bot to "double check" a code change; if the behavior can't be asserted by a Jest test, that's a sign the test is missing, not a reason to fall back to manual e2e. Manual verification against the real workspace is reserved for exactly two situations, both outside this codebase's control:

- **First-time or changed Slack app dashboard configuration** — OAuth scopes, the Events API Request URL, the Interactivity Request URL, slash command registration. These live in Slack's UI (api.slack.com/apps), not in code, so no test can exercise them; see **Slack App Setup** below.
- **The 👀 review flow's actual `claude` CLI run** (`src/review.js`'s `runPrReview`) — it shells out to a real `claude` process against a real local git clone, which only exists on the Mac holding the clones. Its *parsing and orchestration logic* (marker extraction, verdict handling, timeout/error handling, spawn failures) is fully unit-tested with a mocked `child_process.spawn`; only the underlying `claude -p "/review-pr <n>"` behavior itself is out of reach of this suite.

### What a new test needs to cover

For any new Slack event filter, guard clause, or branch: add a test that hits it directly (wrong user, wrong channel, missing data, API returning `null`/failure) — don't just add the happy path. For any new external API call: add both a non-2xx/rejected-promise test and, where the code has a fallback (`??`, `||`, optional chaining), a test that actually exercises the fallback. For any new Slack-facing message or formatting function: assert the exact string, not just "was called."

### A Supertest gotcha that produces false-positive tests

A `request(app).post(...)` call only sends the request once something calls `.then()`/`.catch()`/`await` on it — a bare `const p = request(app)...` assignment never dispatches. Worse, `await request(app)...` only resolves once the response is sent (`res.sendStatus(200)`, which most handlers here call *before* doing the actual async work) — it does **not** wait for the handler's subsequent `await`s to finish. A test that fires two requests back-to-back and asserts a mock was "called once" can pass for the wrong reason (the second request's handler simply hadn't gotten far enough yet) instead of because a guard (e.g. `reviewsInFlight`) actually blocked it — this happened for real in this file and produced a test that showed 0% coverage on the guard it was supposed to prove. When a test needs to prove ordering/concurrency (an in-flight guard, a race between two requests), use the `waitUntil(predicate)` helper defined near the top of `index.test.js` — it polls a real timer until an observable side effect (a mock's call count) is true, which is deterministic regardless of how many event-loop ticks the underlying I/O needs. A fixed number of `setImmediate` ticks is not a substitute for this.

## Slack App Setup

1. Go to api.slack.com/apps → Create New App → From Scratch
2. **OAuth & Permissions** →
   - **Bot Token Scopes**: `chat:write`, `chat:write.public`, `channels:history`, `groups:history`, `reactions:read`, `reactions:write`, `commands`
   - **User Token Scopes**: `search:read` (used by `/tickets` to find your messages anywhere in the workspace)
3. **Event Subscriptions** → enable, set Request URL to `https://<your-app>/slack/events`
4. Subscribe to bot events: `message.channels`, `message.groups`, `reaction_added`
5. **Interactivity & Shortcuts** → enable, set Request URL to `https://<your-app>/slack/interactive` (needed for the `🔍 Review #<n> again` and `Cancel review of #<n>` buttons)
6. **Slash Commands** → Create New Command:
   - Command: `/tickets`
   - Request URL: `https://<your-app>/slack/commands`
   - Short Description: `List Jira tickets mentioned in my channels for a given day`
   - Usage Hint: `[YYYY-MM-DD]`
7. Install to Workspace → copy **Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN` and **User OAuth Token** (`xoxp-...`) into `SLACK_USER_TOKEN`

## Git Hook Setup

```bash
# Symlink the hook into a repo
ln -sf $(pwd)/hooks/post-push /path/to/repo/.git/hooks/post-push
chmod +x hooks/post-push
```
