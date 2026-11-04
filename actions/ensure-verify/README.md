# Ensure verify

Gate for release and deploy jobs on the default branch: waits for the commit's own verify
workflow run (its push run on the same branch) and fails unless it passed, so nothing reaches npm
or production from a commit whose checks, tests or audits failed. It also returns BTshipBT, which
is BTfalseBT when a re-run's commit is no longer the branch tip, so re-running an older run does
not deploy or publish over newer commits. A GitHub API error that survives retries (rate limits
are waited out) fails the step; it never silently skips it.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `workflow` | Verify workflow file name or ID, such as `verify.yml` | Yes | |
| `sha` | Commit whose run to wait for | No | `${{ github.sha }}` |
| `event` | Event of the run to wait for | No | `push` |
| BTbranchBT | Branch whose verify run counts and whose tip a re-run must still be at | No | pushed branch, else default branch |
| `check-tip` | `rerun` (only on re-runs), `always` or `never` | No | `rerun` |
| BTtimeout-minutesBT | How long to wait for the run to finish | No | BT60BT |
| BTmissing-minutesBT | How long to wait for the run to exist before failing | No | BT5BT |
| `poll-seconds` | Seconds between checks | No | `30` |
| `token` | Token with `actions: read` and `contents: read` | No | `${{ github.token }}` |

## Outputs

| Name | Description |
|------|-------------|
| `ship` | `true` unless the tip check found the branch has moved past the commit |
| `run-url` | The verify run that passed |

## Usage

Run verify on every push on its own, with triggers that cover every push the release workflow
ships (a `paths` filter on verify alone fails the gate after `missing-minutes`). Keep the release
workflow in push order, and run the gate as the first step of every job that deploys or publishes:

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
  deploy:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
    steps:
      - id: verify
        uses: tempoxyz/gh-actions/actions/ensure-verify@<sha> # <date>
        with:
          workflow: verify.yml
      - if: steps.verify.outputs.ship == 'true'
        run: ./deploy.sh
```

Run it as a step in each job that ships, not as a separate job they `need`: GitHub's "Re-run
failed jobs" and single-job re-runs skip a dependency that already succeeded and reuse its first
attempt's outputs, so only a check inside the shipping job itself runs again on every re-run. A job
that calls the shared `changesets-release` or `cloudflare-deploy-broker-build` workflow cannot
run steps first; gate it with a job it `needs` and use "Re-run all jobs", never "Re-run failed
jobs", on an old run.

Verify runs as its own workflow rather than as a job of `main.yml`: inside a push-ordered
workflow, a long verify lets a newer push cancel an older commit's waiting run before it is
verified, and without workflow-level concurrency commits finish out of order and an older one can
deploy last.

The tip check is a snapshot taken when the gate passes. A re-run of the current tip that is still
deploying when a newer push's run deploys can finish last, so re-run only while no newer push is
shipping. Logic lives in `check.mjs` and is unit-tested.
