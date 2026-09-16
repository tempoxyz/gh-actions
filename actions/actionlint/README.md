# actionlint

Lint GitHub Actions workflows with [actionlint](https://github.com/rhysd/actionlint), built from upstream commit
[`011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7`](https://github.com/rhysd/actionlint/commit/011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7). Replaces `reviewdog/action-actionlint` for repositories that
only need the lint result as a job status; findings are printed to the log and fail the step.

For a combined security scan (zizmor) and lint, use [`scan-github-actions`](../scan-github-actions)
instead, which runs the same commit-pinned actionlint binary after zizmor.

The runner must have Go installed (as GitHub-hosted Ubuntu runners do). Go automatically
selects a compatible toolchain if needed. The build runs outside the caller checkout;
module downloads are verified through `sum.golang.org`. This commit supports service
container `command` and `entrypoint`, which are not supported by release v1.7.12.

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
