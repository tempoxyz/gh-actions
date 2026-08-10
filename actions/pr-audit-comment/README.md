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
          allowed-associations: OWNER,MEMBER
          allow-same-author: "true"
          organization: tempoxyz
          events-key: ${{ secrets.EVENTS_KEY }}
          events-cert: ${{ secrets.EVENTS_CERT }}
          events-args: ${{ secrets.EVENTS_ARGS }}
          github-token: ${{ github.token }}
```

In `association` mode, `allowed-associations` controls which GitHub author
associations may trigger an audit and, for external forks, which PR authors may
be audited. It accepts comma or whitespace-separated values and defaults to
`OWNER,MEMBER,COLLABORATOR` for compatibility with existing callers.
For a PR whose head branch belongs to the base repository, the trusted
commenter is the authorization boundary. External-fork authors remain subject
to the configured association check. Set `allow-same-author: "true"` to let a
trusted commenter audit their own external-fork PR; identity is established by
matching non-null numeric GitHub user IDs.

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
- `perf`
- `note="..."`
