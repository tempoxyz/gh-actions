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

In `association` mode, an owner, member, or collaborator may trigger an audit.
If that trusted commenter is also the PR author, matching non-null numeric
GitHub user IDs avoids rejecting them when the fetched author association is
weaker. PRs whose head branch belongs to the base repository are also allowed:
the trusted commenter is the authorization boundary, while external-fork
authors remain subject to the association check.

For `permission-check-mode: org`, `permission-token` can provide a token with
organization membership access independently from `github-token`, which
continues to handle PR reads and status comments. If `permission-token` is not
set, membership checks use `github-token` as before.

```yaml
          permission-check-mode: org
          organization: tempoxyz
          github-token: ${{ secrets.DEREK_BENCH_TOKEN }}
          permission-token: ${{ secrets.DEREK_BENCH_ACK_TOKEN }}
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
