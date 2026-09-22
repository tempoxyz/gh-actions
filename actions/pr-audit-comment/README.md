# pr-audit-comment

Handles PR audit commands posted as issue comments and publishes `pr_audit` events.

Because it needs `issues: write` and `pull-requests: write`, use it in a caller-owned job. `pull-requests: write` is required even though the action only reads the pull request: commenting on a pull request and reacting to a comment on one both go through the issues endpoints but are governed by the `pull-requests` permission, so with `pull-requests: read` the acknowledgement comment and reaction fail with `Resource not accessible by integration`. Those calls are best-effort, so the job still succeeds and the audit still runs — the symptom is a silent audit with no acknowledgement and no feedback on a mistyped command. This is the privileged counterpart to the read-only [`pr-audit`](../../README.md#pr-audit) reusable workflow.

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
      pull-requests: write
    steps:
      - uses: tempoxyz/gh-actions/actions/pr-audit-comment@main
        with:
          command-regex: '^(?:@decofe\s+)?(?:cyclops\s+audit|derek\s+audit)\b'
          permission-check-mode: association
          allowed-associations: OWNER,MEMBER
          organization: tempoxyz
          events-key: ${{ secrets.EVENTS_KEY }}
          events-cert: ${{ secrets.EVENTS_CERT }}
          events-args: ${{ secrets.EVENTS_ARGS }}
          github-token: ${{ github.token }}
```

## Authorization

Authorization applies to the user who posts the audit command, not the author
of the pull request. A trusted commenter can therefore request an audit for any
pull request, including one opened from an external fork by a contributor.

In `association` mode, `allowed-associations` controls which commenters may
trigger an audit. It accepts comma- or whitespace-separated values and defaults
to `OWNER,MEMBER,COLLABORATOR` for compatibility with existing callers.

`allow-same-author` remains accepted for compatibility with existing callers,
but is deprecated and has no effect. It can be removed from caller workflows.

For `permission-check-mode: org`, `permission-token` can provide a token with
organization membership access independently from `github-token`, which
continues to handle PR reads and status comments. If `permission-token` is not
set, membership checks use `github-token` as before. This mode checks whether
the commenter is an organization member; it does not check the PR author.

```yaml
          permission-check-mode: org
          organization: tempoxyz
          github-token: ${{ secrets.DEREK_BENCH_TOKEN }}
          permission-token: ${{ secrets.DEREK_BENCH_ACK_TOKEN }}
```

Supported default commands:

- `cyclops audit`
- `cyclops private audit`
- `@decofe cyclops audit`
- `@decofe cyclops private audit`
- `derek audit`

Supported arguments:

- `super-fast` (single pass against `pr-review-super-fast.yaml`, roughly five minutes; `superfast` is accepted too)
- `fast`
- `iterations=N`
- `hours=N`
- `config=PATH`
- `models=...`
- `run-label=LABEL`
- `runner=v1|v2` (defaults to `v1`; use `v2` for a canary run)
- `dry-run`
- `private` (also accepted before `audit`; publishes findings only to Linear and links them from Slack)
- `perf`
- `note="..."`
