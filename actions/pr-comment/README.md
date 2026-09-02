# PR comment

Keep one pull request (or issue) comment up to date. The comment is identified by a hidden
marker derived from `header`, so re-running a workflow edits the same comment instead of adding
another. Replaces `marocchino/sticky-pull-request-comment` and the
`peter-evans/find-comment` + `create-or-update-comment` pair.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `token` | Token with `pull-requests: write` (`issues: write` for issues) | No | `${{ github.token }}` |
| `number` | PR or issue number | No | the PR/issue of the current event |
| `header` | Marker identifying the comment; one comment per header | No | `${{ github.workflow }}` |
| `message` | Comment body (Markdown); ignored when `path` is set | No | `""` |
| `path` | File whose contents are the body | No | `""` |
| `mode` | `replace`, `append`, or `delete` | No | `replace` |

## Outputs

| Name | Description |
|------|-------------|
| `comment-id` | ID of the created or updated comment |

## Usage

```yaml
permissions:
  pull-requests: write
steps:
  - uses: tempoxyz/gh-actions/actions/pr-comment@main
    with:
      header: coverage
      path: coverage-report/summary.md
```

Mapping from `sticky-pull-request-comment`: `header`, `message`, `path`, `number` are the same;
`recreate`/`hide_and_recreate` are not offered (use `mode: delete` then a fresh comment if
needed). Uses only `gh api`; nothing is downloaded.
