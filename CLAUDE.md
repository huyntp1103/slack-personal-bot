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
│   ├── github.js         # GitHub PR data fetcher (title, base branch)
│   └── utils.js          # extractJiraKey(), extractSlackThread()
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
| ✅ reaction on message in `#backend-review-code` | Slack `reaction_added` event | Reaction by `MY_SLACK_USER_ID`, PR base branch is `develop` | → QA Ready + comment + Slack thread reply (if Bug) |

## Jira Key Format

Extracted from PR title or commit message using `/[A-Z]+-\d+/`.

Example: `feat(similar-weight-rep): UP-68162 get max weight in many reps matched` → `UP-68162`

Jira key is first looked up in Slack message text, then falls back to fetching the GitHub PR title via the API.

Jira base URL: `https://everfit.atlassian.net/browse/<KEY>`

## Transition Guard Rules

| Target Status | Required Current Status | Extra Condition |
| --- | --- | --- |
| In Progress | To Do | Ticket must NOT be in sprint id `249` (Active Sprint Backlog) |
| In Review | In Progress | — |
| QA Ready | In Review | PR base branch must be `develop` |

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
  - PR base branch must be `develop`

## Slack URL Verification

Slack sends a `url_verification` challenge on first setup. The `/slack/events` endpoint responds with `{ challenge }`.

## Dry Run Mode

Set `DRY_RUN=true` to preview all actions without touching Jira or Slack. Preview messages are posted to `SLACK_PREVIEW_CHANNEL` showing `current status → target status`.

## Environment Variables

| Variable | Description |
| --- | --- |
| `JIRA_HOST` | `https://everfit.atlassian.net` |
| `JIRA_EMAIL` | Your Atlassian account email |
| `JIRA_TOKEN` | API token from id.atlassian.com |
| `SLACK_BOT_TOKEN` | `xoxb-...` Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | From Slack App → Basic Information |
| `MY_SLACK_USER_ID` | Your Slack member ID (e.g. `U093ZDNQJF3`) |
| `SLACK_REVIEW_CHANNEL` | Channel ID for `#backend-review-code` |
| `MY_GITHUB_USERNAME` | Your GitHub username |
| `GITHUB_TOKEN` | Personal access token (repo scope) for PR API |
| `ID_IN_PROGRESS` | Jira transition ID for "In Progress" |
| `ID_IN_REVIEW` | Jira transition ID for "In Review" |
| `ID_QA_READY` | Jira transition ID for "QA Ready" |
| `BOT_URL` | Deployed bot URL (used by git hook) |
| `DRY_RUN` | Set `true` to preview actions without executing |
| `SLACK_PREVIEW_CHANNEL` | Channel ID for dry-run previews |
| `PORT` | Server port (default: 3000) |

## Key Behaviors

- **Silent mode**: All Slack filters check `MY_SLACK_USER_ID` — other people's messages/reactions are ignored.
- **Jira key extraction**: Regex `/[A-Z]+-\d+/` on message text first, then GitHub PR title as fallback.
- **Slack thread reply**: For Bug-type tickets on merge, extracts Slack archive URL from Jira description (`archives/CXXX/pTIMESTAMP`) and replies to that thread.
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

## Slack App Setup

1. Go to api.slack.com/apps → Create New App → From Scratch
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `chat:write.public`, `channels:history`, `groups:history`, `reactions:read`
3. **Event Subscriptions** → enable, set Request URL to `https://<your-app>/slack/events`
4. Subscribe to bot events: `message.channels`, `message.groups`, `reaction_added`
5. Install to Workspace → copy Bot User OAuth Token

## Git Hook Setup

```bash
# Symlink the hook into a repo
ln -sf $(pwd)/hooks/post-push /path/to/repo/.git/hooks/post-push
chmod +x hooks/post-push
```
