# actionlint

Lint GitHub Actions workflows with [actionlint](https://github.com/rhysd/actionlint), run from the
digest-pinned upstream container image. Replaces `reviewdog/action-actionlint` for repositories that
only need the lint result as a job status; findings are printed to the log and fail the step.

For a combined security scan (zizmor) and lint, use [`scan-github-actions`](../scan-github-actions)
instead, which runs the same pinned actionlint image after zizmor.

## Inputs

| Input | Description | Required | Default |
| --- | --- | --- | --- |
| `args` | Arguments passed to actionlint | No | `-color` |

## Usage

```yaml
jobs:
  actionlint:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false
      - uses: tempoxyz/gh-actions/actions/actionlint@<sha>
```

Lint a single workflow, or pass any other actionlint flag:

```yaml
      - uses: tempoxyz/gh-actions/actions/actionlint@<sha>
        with:
          args: -color .github/workflows/ci.yml
```

actionlint reads `.github/actionlint.yaml` from the repository when present.
