# Implementation Plan: GitHub → Jira → Slack Bot (Slack-driven)

## Status: Implemented ✅

## Architecture

```
git push (local hook) ──────────────────────────────► POST /git/push → Jira: In Progress
Slack #backend-review-code (new root message) ───────► POST /slack/events → Jira: In Review
Slack #backend-review-code (✅ reaction added) ──────► POST /slack/events → Jira: QA Ready + comment + Slack thread
```

## Source Files

| File | Responsibility |
| --- | --- |
| `src/index.js` | Express server, route handlers, Slack signature verification |
| `src/jira.js` | `transitionIssue`, `addComment`, `getIssue` |
| `src/slack.js` | `replyToThread`, `fetchMessage`, `preview` |
| `src/github.js` | `fetchPrData` (title + base branch), `fetchPrTitle` |
| `src/utils.js` | `extractJiraKey`, `extractSlackThread` |
| `hooks/post-push` | Bash git hook — detects first push, calls `/git/push` |

## Transition Guard Logic (in `transitionIssue`)

```
1. Fetch issue from Jira (status + sprint fields)
2. Check required current status:
   - → In Progress  requires current = "To Do"
   - → In Review    requires current = "In Progress"
   - → QA Ready     requires current = "In Review"
   - other targets: no restriction
3. If → In Progress: check customfield_10010 (sprint array) — block if any sprint.id === 249
4. If DRY_RUN=true: post preview to SLACK_PREVIEW_CHANNEL, return true
5. Call doTransition
6. Return true on success, false on skip or error
```

Callers check the return value — `addComment` and `replyToThread` are only called if `transitionIssue` returns `true`.

## handleReviewMessage Flow

```
1. Filter: user === MY_SLACK_USER_ID
2. Filter: channel === SLACK_REVIEW_CHANNEL
3. Filter: root message (no thread_ts or thread_ts === ts)
4. Strip Slack angle-bracket URL wrapping: <https://...> → https://...
5. Match GitHub PR URL regex
6. extractJiraKey from message text
7. If no key: fetchPrTitle(prUrl) → extractJiraKey from title
8. transitionIssue(key, ID_IN_REVIEW)
```

## handleReactionAdded Flow

```
1. Filter: user === MY_SLACK_USER_ID
2. Filter: reaction === "white_check_mark"
3. Filter: item.channel === SLACK_REVIEW_CHANNEL
4. fetchMessage(channel, ts) → get original message text
5. Strip angle-bracket URL wrapping
6. Match GitHub PR URL regex
7. fetchPrData(prUrl) → { title, baseBranch }
8. extractJiraKey from message text, fallback to PR title
9. Check baseBranch === "develop" — skip if not
10. transitionIssue(key, ID_QA_READY) → if false, stop
11. addComment(key, "Ready for QA testing")
12. getIssue(key) → if Bug: extractSlackThread(description) → replyToThread
```

## Slack Signing Verification

```
basestring = "v0:" + X-Slack-Request-Timestamp + ":" + rawBody
digest = "v0=" + hmac_sha256(SLACK_SIGNING_SECRET, basestring)
compare with X-Slack-Signature using timingSafeEqual
Reject if |now - timestamp| > 300s
Skip Slack retries (X-Slack-Retry-Num header)
```

## post-push Hook Logic

```
1. Get current branch
2. Skip if branch is HEAD / main / master / develop
3. Check if remote ref had prior history (git rev-parse refs/remotes/origin/BRANCH@{1})
4. If no prior history → first push → extract Jira key from commit message or branch name
5. POST {jiraKey} to $BOT_URL/git/push
6. Failures are non-fatal (--max-time 5, fallback echo)
```

## Dry Run Mode

`DRY_RUN=true` → all write operations (transition, comment, Slack reply) post a preview to `SLACK_PREVIEW_CHANNEL` instead. Preview format: `current status → target status`.

## Test Coverage

```
tests/utils.test.js    — extractJiraKey, extractSlackThread (edge cases, ADF, null)
tests/github.test.js   — fetchPrData, fetchPrTitle (fetch mock, error handling)
tests/jira.test.js     — transitionIssue guards, dry run, addComment
tests/index.test.js    — all HTTP routes via supertest (49 tests total)
```

Run: `npm test`

## Slack App Scopes Required

| Scope | Why |
| --- | --- |
| `chat:write` | Post messages in channels bot is member of |
| `chat:write.public` | Post in public channels without joining |
| `channels:history` | Read messages in public channels |
| `groups:history` | Read messages in private channels |
| `reactions:read` | Receive `reaction_added` events |

## Deployment Checklist (Railway)

1. Set all env vars in Railway Variables tab
2. Deploy → get public URL
3. Slack App → Event Subscriptions → Request URL → `https://<app>.railway.app/slack/events`
4. Subscribe bot events: `message.channels`, `message.groups`, `reaction_added`
5. Reinstall app to workspace after scope changes
6. Install git hook: `ln -sf $(pwd)/hooks/post-push /path/to/repo/.git/hooks/post-push`
7. Set `BOT_URL=https://<app>.railway.app` in prod `.env`
8. Set `DRY_RUN=false` when ready to go live
