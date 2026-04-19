# Test Slack Event Locally

Simulates a Slack event payload against the local server.

Usage: `/test-slack-event <event>` — event is one of: `message`, `reaction`

```bash
EVENT=$ARGUMENTS

if [ "$EVENT" = "message" ]; then
  PAYLOAD='{
    "type": "event_callback",
    "event": {
      "type": "message",
      "user": "'"${MY_SLACK_USER_ID}"'",
      "channel": "'"${SLACK_REVIEW_CHANNEL}"'",
      "text": "PR ready for review UP-68162 https://github.com/org/repo/pull/1",
      "ts": "1712345678.901234"
    }
  }'
elif [ "$EVENT" = "reaction" ]; then
  PAYLOAD='{
    "type": "event_callback",
    "event": {
      "type": "reaction_added",
      "user": "'"${MY_SLACK_USER_ID}"'",
      "reaction": "white_check_mark",
      "item": {
        "type": "message",
        "channel": "'"${SLACK_REVIEW_CHANNEL}"'",
        "ts": "1712345678.901234"
      }
    }
  }'
fi

curl -s -X POST http://localhost:3000/slack/events \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
```
