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
| `src/github.js` | `fetchPrData` (title + base branch), `fetchPrTitle`, `fetchPrCommits` (commit messages + author logins) |
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
4. Emit preview via preview() — terminal log + SLACK_PREVIEW_CHANNEL post
5. Call doTransition
6. Return true on success, false on skip or error
```

`addComment` works the same way — emits a preview, then performs the Jira call. Both always execute the real Jira mutation regardless of `DRY_RUN`. Only `replyToThread` is gated by `DRY_RUN=true` (preview still emits, real Slack post is suppressed).

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
5. Strip angle-bracket URL wrapping, match GitHub PR URL regex (else stop)
6. fetchPrData(prUrl) → { title, baseBranch }
7. Allow only baseBranch ∈ {develop, releasing_staging, main, master}
8. Resolve Jira keys to process:
   - If baseBranch === "releasing_staging":
       fetchPrCommits(prUrl) → filter by (authorLogin === MY_GITHUB_USERNAME || committerLogin === MY_GITHUB_USERNAME)
       → extractJiraKey(message) → unique → array of keys
       (committer match catches cherry-picks where you applied someone else's commit)
   - Else: extractJiraKey(message text) || extractJiraKey(PR title) → single key
9. For each jiraKey, processQaReadyTicket(jiraKey, baseBranch):
   a. transitionIssue(key, ID_QA_READY) → if false, return
   b. If baseBranch ∈ {main, master}: stop here (transition only)
   c. Wait QA_NOTIFY_DELAY_MINUTES
   d. addComment(key, "Ready for QA testing")
   e. getIssue(key) → if Bug: extractSlackThread(description) → replyToThread
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

## Preview & Dry Run Mode

`preview(text)` always logs `[PREVIEW] ...` to terminal and (if `SLACK_PREVIEW_CHANNEL` is set) posts to that channel. It is called unconditionally before each Jira transition, Jira comment, and Slack thread reply.

`DRY_RUN=true` only suppresses the real `chat.postMessage` call inside `replyToThread`. Jira transitions and comments still execute. Preview output is unaffected by `DRY_RUN`.

## Test Coverage

```
tests/utils.test.js    — extractJiraKey, extractSlackThread (edge cases, ADF, null)
tests/github.test.js   — fetchPrData, fetchPrTitle, fetchPrCommits (fetch mock, error handling)
tests/jira.test.js     — transitionIssue guards (status, sprint 249, API failure), addComment
tests/index.test.js    — all HTTP routes via supertest (handleReviewMessage, handleReactionAdded with branch routing for develop/releasing_staging/main/master, /git/push)
```

Total: 56 tests. Run: `npm test`.

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
