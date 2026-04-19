# Find Jira Transition IDs

Fetches all available transition IDs for a given Jira issue key.

Usage: `/find-transition-ids PROJ-123`

```bash
curl --request GET \
  --url "${JIRA_HOST}/rest/api/2/issue/$ARGUMENTS/transitions" \
  --user "${JIRA_EMAIL}:${JIRA_TOKEN}" \
  --header "Accept: application/json" | jq '.transitions[] | {id, name: .name}'
```
