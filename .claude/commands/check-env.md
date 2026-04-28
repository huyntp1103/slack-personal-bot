# Check Environment Variables

Verifies all required environment variables are set (does not print values).

```bash
REQUIRED=(JIRA_HOST JIRA_EMAIL JIRA_TOKEN SLACK_BOT_TOKEN SLACK_SIGNING_SECRET MY_SLACK_USER_ID SLACK_REVIEW_CHANNEL MY_GITHUB_USERNAME GITHUB_TOKEN ID_IN_PROGRESS ID_IN_REVIEW ID_QA_READY BOT_URL)
MISSING=()

for VAR in "${REQUIRED[@]}"; do
  if [ -z "${!VAR}" ]; then
    MISSING+=("$VAR")
  else
    echo "✓ $VAR"
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "Missing variables:"
  for VAR in "${MISSING[@]}"; do echo "  ✗ $VAR"; done
  exit 1
else
  echo ""
  echo "All required environment variables are set."
fi
```
