# pr-audit-comment

Handles PR audit commands posted as issue comments and publishes `pr_audit` events.

Because it needs `issues: write` and `pull-requests: read`, use it in a caller-owned job. This is the privileged counterpart to the read-only [`pr-audit`](../../README.md#pr-audit) reusable workflow.

```yaml
on:
  issue_comment:
    types: [created]

jobs:
  pr-audit-comment:
    if: github.event.issue.pull_request
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
      - uses: tempoxyz/gh-actions/actions/pr-audit-comment@main
        with:
          command-regex: '^(?:@decofe\s+)?(?:cyclops\s+audit|derek\s+audit)\b'
          permission-check-mode: association
          organization: tempoxyz
          events-key: ${{ secrets.EVENTS_KEY }}
          events-cert: ${{ secrets.EVENTS_CERT }}
          events-args: ${{ secrets.EVENTS_ARGS }}
          github-token: ${{ github.token }}
```

Supported default commands:

- `cyclops audit`
- `@decofe cyclops audit`
- `derek audit`

Supported arguments:

- `fast`
- `iterations=N`
- `hours=N`
- `config=PATH`
- `models=...`
- `run-label=LABEL`
- `dry-run`
- `note="..."`

In `association` permission mode, a trusted commenter who is also the PR author
is accepted by matching their GitHub user IDs. Different commenters still
require the PR author's fetched association to be `OWNER`, `MEMBER`, or
`COLLABORATOR`.
