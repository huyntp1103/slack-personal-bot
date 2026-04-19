# Implementation Plan: GitHub → Jira → Slack Bot (Slack-driven)

## Architecture Summary

No GitHub webhooks (team repo blocks it). Instead:

```
git push (local hook) ──────────────────────────────► POST /git/push → Jira: In Progress
Slack #backend-review-code (new root message) ───────► POST /slack/events → Jira: In Review
Slack #backend-review-code (✅ reaction added) ──────► POST /slack/events → Jira: QA Ready + comment + Slack thread
```

---

## Implementation Order

```
Phase 0: Scaffolding (package.json, .env.example)          ✅ done
Phase 1: src/utils.js                                       ✅ done
Phase 2: src/jira.js                                        ✅ done
Phase 3: src/slack.js                                       ✅ done
Phase 4: src/index.js — add /slack/events route             ← rewrite needed
Phase 5: hooks/post-push — local git hook                   ← new
Phase 6: Update .env.example with new vars                  ← new
```

---

## Phase 4: `src/index.js` — Rewrite

Remove the old `/webhook` GitHub route. Add two routes:

### `POST /slack/events`

Handles all inbound Slack events. Must:

1. **Respond immediately with 200** (Slack retries if no fast response)
2. **Handle `url_verification`** challenge (one-time setup ping from Slack)
3. **Verify Slack signing secret** via `X-Slack-Signature` + `X-Slack-Request-Timestamp`
   - HMAC-SHA256 of `v0:<timestamp>:<raw body>` with `SLACK_SIGNING_SECRET`
   - Compare against `X-Slack-Signature` header
   - Reject if timestamp is >5 minutes old (replay attack protection)
4. **Route by `event.type`**:
   - `message` → `handleReviewMessage(event)`
   - `reaction_added` → `handleReactionAdded(event)`

### `handleReviewMessage(event)`

Trigger: In Review

Conditions (all must pass):
- `event.user === MY_SLACK_USER_ID`
- `event.channel === SLACK_REVIEW_CHANNEL`
- No `event.thread_ts`, or `event.thread_ts === event.ts` (root message only)
- `event.text` contains a GitHub PR URL (match `github.com/.*/pull/\d+`)
- Extract Jira key from `event.text` via `/[A-Z]+-\d+/`

Action: `transitionIssue(key, ID_IN_REVIEW)`

### `handleReactionAdded(event)`

Trigger: QA Ready + Slack notify

Conditions (all must pass):
- `event.user === MY_SLACK_USER_ID`
- `event.reaction === 'white_check_mark'`
- `event.item.type === 'message'`
- `event.item.channel === SLACK_REVIEW_CHANNEL`

Flow:
1. Fetch the original message via `slack.conversations.history` with `channel` + `latest=event.item.ts` + `limit=1` + `inclusive=true`
2. Extract Jira key from the message text
3. `transitionIssue(key, ID_QA_READY)`
4. `addComment(key, "✅ Fixed and merged. Ready for QA.\nPR: <pr_url>")`
5. `getIssue(key)` → if type is Bug → `extractSlackThread(description)` → `replyToThread(...)`

### `POST /git/push`

Called by the local `post-push` hook.

Body: `{ jiraKey: "UP-68162" }`

Action: `transitionIssue(jiraKey, ID_IN_PROGRESS)`

No auth needed (localhost only — the hook calls `http://localhost:3000/git/push`). On Railway, this endpoint should be firewall-restricted or accept a simple shared secret via header.

---

## Phase 5: `hooks/post-push`

Shell script installed as `.git/hooks/post-push` in the target repo.

Logic:
1. Get current branch: `git rev-parse --abbrev-ref HEAD`
2. Check if branch has a remote upstream: `git rev-parse --abbrev-ref @{u} 2>/dev/null`
3. If no upstream → this is the first push (new branch = new PR starting) → extract Jira key from branch name or last commit message → POST to `$BOT_URL/git/push`
4. If upstream exists → already pushed before → skip (avoid re-triggering In Progress)

Jira key extraction from commit: `git log -1 --pretty=%s` → regex `/[A-Z]+-\d+/`
Fallback: extract from branch name.

---

## Slack Signing Verification — Critical Details

```
basestring = "v0:" + X-Slack-Request-Timestamp + ":" + raw_body
sig = "v0=" + hmac_sha256(SLACK_SIGNING_SECRET, basestring)
compare with X-Slack-Signature header using timingSafeEqual
```

Must use `req.rawBody` (not re-serialized JSON) — same gotcha as GitHub signature.
Reject requests where `|Date.now()/1000 - timestamp| > 300` (5 min replay window).

---

## Edge Cases

| # | Case | Handling |
| --- | --- | --- |
| 1 | Slack retries the same event | Slack sends `X-Slack-Retry-Num` header on retry — respond 200 immediately and skip processing |
| 2 | Message has no Jira key | Log and return silently |
| 3 | Message is a reply, not root | Check `thread_ts === ts` or `!thread_ts` |
| 4 | Reaction on someone else's message | `event.item_user !== MY_SLACK_USER_ID` check (belt-and-suspenders) |
| 5 | Transition 400 (already in state) | try/catch in `transitionIssue` — already handled |
| 6 | `url_verification` on first Slack setup | Return `{ challenge }` immediately |
| 7 | `post-push` on upstream push (not first) | Check for existing `@{u}` — skip if found |

---

## New Environment Variables (additions to existing)

```
SLACK_SIGNING_SECRET=   # From Slack App → Basic Information
MY_SLACK_USER_ID=       # Your Slack member ID (Settings → Profile → copy member ID)
SLACK_REVIEW_CHANNEL=   # Channel ID for #backend-review-code (not the name)
BOT_URL=                # http://localhost:3000 (dev) or https://<app>.railway.app (prod)
```

---

## Slack App Scopes Required

| Scope | Why |
| --- | --- |
| `chat:write` | Post messages in channels bot is member of |
| `chat:write.public` | Post in public channels without joining |
| `channels:history` | Read messages to fetch original message on reaction |
| `reactions:read` | Receive `reaction_added` events |

---

## Deployment Checklist (Railway)

1. Set all env vars including new Slack ones
2. Deploy — get public URL
3. In Slack App → Event Subscriptions → set Request URL to `https://<app>.railway.app/slack/events`
4. Slack will send `url_verification` — bot must respond with `{ challenge }`
5. Subscribe to: `message.channels`, `reaction_added`
6. Install git hook into your work repos via symlink
7. Set `BOT_URL=https://<app>.railway.app` in prod env (git hook posts there)
