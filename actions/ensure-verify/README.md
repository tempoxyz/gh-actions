# Ensure verify

Gate for release and deploy jobs on the default branch: waits for the commit's own verify
workflow run (its push run) and fails unless it passed, so nothing reaches npm or production
from a commit whose checks, tests or audits failed. It also returns `ship`, which is `false`
when a re-run's commit is no longer the branch tip, so re-running an older run never deploys
or publishes over newer commits. A GitHub API error that survives retries fails the step; it
never silently skips it.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `workflow` | Verify workflow file name or ID, such as `verify.yml` | Yes | |
| `sha` | Commit whose run to wait for | No | `${{ github.sha }}` |
| `event` | Event of the run to wait for | No | `push` |
| `branch` | Branch a re-run must still be the tip of | No | default branch |
| `check-tip` | `rerun` (only on re-runs), `always` or `never` | No | `rerun` |
| `timeout-minutes` | How long to wait for the run | No | `60` |
| `poll-seconds` | Seconds between checks | No | `30` |
| `token` | Token with `actions: read` and `contents: read` | No | `${{ github.token }}` |

## Outputs

| Name | Description |
|------|-------------|
| `ship` | `true` unless the tip check found the branch has moved past the commit |
| `run-url` | The verify run that passed |

## Usage

Run verify on every push on its own, keep the release workflow in push order, and make every
job that deploys or publishes need the gate:

```yaml
# verify.yml
on:
  push:
    branches: [main]
  pull_request:
```

```yaml
# main.yml
on:
  push:
    branches: [main]

# Push order: a newer push replaces a waiting run, so the newest commit ships next. Re-runs
# get their own group so they never replace the newest commit's waiting run.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}-${{ github.run_attempt == '1' && 'push' || github.sha }}
  cancel-in-progress: false

jobs:
  ensure-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 65
    permissions:
      actions: read
      contents: read
    outputs:
      ship: ${{ steps.verify.outputs.ship }}
    steps:
      - id: verify
        uses: tempoxyz/gh-actions/actions/ensure-verify@<sha> # <date>
        with:
          workflow: verify.yml

  deploy:
    needs: ensure-verify
    if: needs.ensure-verify.outputs.ship == 'true'
    # ...

  publish:
    needs: ensure-verify
    if: needs.ensure-verify.outputs.ship == 'true'
    # ...
```

Verify runs as its own workflow rather than as a job of `main.yml`: inside a push-ordered
workflow, a long verify lets a newer push cancel an older commit's waiting run before it is
verified, and without workflow-level concurrency commits finish out of order and an older one
can deploy last. A job that calls the shared `changesets-release` or
`cloudflare-deploy-broker-build` workflow is gated the same way with
`needs: ensure-verify`. Logic lives in `check.mjs` and is unit-tested.
