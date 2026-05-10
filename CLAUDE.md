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
│   └── utils.js          # extractJiraKey(), extractAllJiraKeys(), extractSlackThread()
├── hooks/
│   └── post-push         # Local git hook script (symlinked into repos)
├── tests/
│   ├── utils.test.js
│   ├── github.test.js
│   ├── jira.test.js
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
| ✅ reaction on message in `#backend-review-code` | Slack `reaction_added` event | Reaction by `MY_SLACK_USER_ID`, PR base branch in `develop`, `releasing_staging`, `main`, `master` | → QA Ready (always) + comment + Slack thread reply (only when base is `develop` or `releasing_staging`) |
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

- **`reaction_added` event** (QA Ready trigger):
  - Reaction: `white_check_mark` (✅)
  - `event.user === MY_SLACK_USER_ID`
  - `event.item.type === 'message'`
  - Channel: `SLACK_REVIEW_CHANNEL`
  - PR base branch must be one of `develop`, `releasing_staging`, `main`, `master`
  - **`releasing_staging` PRs**: contain commits from many people, so the bot fetches the PR commit list, filters to commits where `MY_GITHUB_USERNAME` is the **author OR committer** (so cherry-picked commits count too), dedupes by Jira key, and processes each ticket independently
  - **For all other branches**: single ticket extracted from the Slack message text or PR title
  - **Notification scope**: comment + Slack thread reply only fire for `develop` and `releasing_staging`. For `main`/`master`, the bot transitions the ticket and stops.

## Slack URL Verification

Slack sends a `url_verification` challenge on first setup. The `/slack/events` endpoint responds with `{ challenge }`.

## Preview & Dry Run Mode

Every Jira transition, Jira comment, and Slack thread reply emits a preview line via `preview()` — printed to the terminal as `[PREVIEW] ...` and (if `SLACK_PREVIEW_CHANNEL` is set) posted to that channel. Previews always run regardless of `DRY_RUN`.

`DRY_RUN=true` only gates the **Slack thread reply** (`replyToThread`) — when on, the bot still previews the reply but does not post it to the real thread. Jira transitions and comments always execute.

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
| `PORT` | Server port (default: 3000) |

## Key Behaviors

- **Silent mode**: All Slack filters check `MY_SLACK_USER_ID` — other people's messages/reactions are ignored.
- **Jira key extraction**: Regex `/[A-Z]+-\d+/` on message text first, then GitHub PR title as fallback.
- **Slack thread reply**: For Bug-type tickets after a `develop`/`releasing_staging` PR is approved, extracts Slack archive URL from Jira description (`archives/CXXX/pTIMESTAMP`) and replies to that thread. Skipped for `main`/`master` PRs.
- **QA notification delay**: After transitioning to QA Ready, the bot waits `QA_NOTIFY_DELAY_MINUTES` (default 15) before posting the Jira comment and Slack thread reply.
- **Auto worklog before In Review**: When transitioning In Progress → In Review, the bot first calls `POST /rest/api/2/issue/<KEY>/worklog` with `timeSpentSeconds=3600`, `started=<today>T12:00:00.000+0700` (Asia/Bangkok day), and comment `[Generated by personal bot] Implement based on solution design & implementation plan, self-review, self-test`. If the status guard skips the transition, no worklog is created.
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
npm test
```

After modifying any source file, always consider whether new or updated tests are needed to cover the changed logic, then run `npm test` to confirm all tests pass before considering the task complete.

## Slack App Setup

1. Go to api.slack.com/apps → Create New App → From Scratch
2. **OAuth & Permissions** →
   - **Bot Token Scopes**: `chat:write`, `chat:write.public`, `channels:history`, `groups:history`, `reactions:read`, `commands`
   - **User Token Scopes**: `search:read` (used by `/tickets` to find your messages anywhere in the workspace)
3. **Event Subscriptions** → enable, set Request URL to `https://<your-app>/slack/events`
4. Subscribe to bot events: `message.channels`, `message.groups`, `reaction_added`
5. **Slash Commands** → Create New Command:
   - Command: `/tickets`
   - Request URL: `https://<your-app>/slack/commands`
   - Short Description: `List Jira tickets mentioned in my channels for a given day`
   - Usage Hint: `[YYYY-MM-DD]`
6. Install to Workspace → copy **Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN` and **User OAuth Token** (`xoxp-...`) into `SLACK_USER_TOKEN`

## Git Hook Setup

```bash
# Symlink the hook into a repo
ln -sf $(pwd)/hooks/post-push /path/to/repo/.git/hooks/post-push
chmod +x hooks/post-push
```
