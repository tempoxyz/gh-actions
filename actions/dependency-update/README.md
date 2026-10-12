# Dependency update and repair

[`dependency-update.yml`](../../.github/workflows/dependency-update.yml) shares
the mechanical update/repair flow: trusted adapter → lockfile/check/repair loop →
validated PR → exact-head CI/repair loop. Release selection, audit/benchmark
requests, deployment, and auto-merge remain in the caller repository.

## Caller

This is a generic example; replace the SHA/image placeholders with reviewed
releases. The workflow and any worker image must be pinned immutably.

```yaml
name: Update SDK
on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
permissions: {}
concurrency:
  group: update-sdk
  cancel-in-progress: false
jobs:
  update:
    if: github.repository == 'example/service' && github.ref == 'refs/heads/main'
    uses: tempoxyz/gh-actions/.github/workflows/dependency-update.yml@<shared-sha>
    permissions:
      contents: read
      actions: read
      pull-requests: read
      id-token: write
    with:
      adapter-script: scripts/prepare_sdk_update.py
      requested-ref: main
      sts-policy: update-sdk
      worker-image: ghcr.io/example/repair@sha256:<approved-image-digest>
      environment: dependency-updates
      local-checks: |
        cargo fmt --all --check
        cargo clippy --workspace --all-targets --locked -- -D warnings
        cargo nextest run --locked --no-run
      allowed-paths: |
        Cargo.toml
        Cargo.lock
        src/**/*.rs
        tests/**/*.rs
      required-workflows: |
        .github/workflows/lint.yml
        .github/workflows/test.yml
      repair-instructions: Migrate SDK APIs without weakening invariants or tests.
      max-local-repairs: 3
      max-ci-repairs: 3
      repair-budget-minutes: 120
    secrets:
      AMP_API_KEY: ${{ secrets.AMP_API_KEY }}
```

The caller owns scheduling and concurrency. Calls are accepted only from `main`
on schedule/manual dispatch. `runner` defaults to `ubuntu-latest` and
`worker-memory` to `4g`; choose limits/image tools appropriate to the workspace.
Python 3.11+, Docker, Node, Git, and gh must be available on the Linux runner.

Only named Amp credentials are forwarded. A public reusable workflow runs in
the caller's context; private inputs, source, PRs and logs belong to the caller.
Keep private adapters, prompts and real diagnostic fixtures in that repository.

## Adapter contract

The caller keeps a tracked, standalone, standard-library Python script on main.
The coordinator copies it outside the worker and invokes it with Python isolated
mode, so candidate source cannot replace it or supply imports. The adapter gets
only a read-scoped GitHub token, never a publishing token or the Amp key.

`python3 adapter.py resolve` receives `UPDATE_REQUESTED_REF` and prints exactly
one JSON plan to stdout. Diagnostics go to stderr. It selects the upstream
revision once and implements release eligibility/downgrade/no-op rules. Return
`{"schema_version": 1, "skip": true}` when no update is needed; otherwise:

```json
{
  "schema_version": 1,
  "update_id": "v1.2.3",
  "branch": "automation/sdk-v1.2.3",
  "title": "deps: update SDK to v1.2.3",
  "body": "Update to the selected published SDK release.",
  "closed_pr_policy": "skip",
  "pins": {
    "https://github.com/example/sdk": "1111111111111111111111111111111111111111"
  }
}
```

`python3 adapter.py apply --plan <trusted-plan.json>` runs with the exported
candidate as its working directory. It edits manifest pins deterministically,
preserving the selected SHAs, and does not run Cargo or other candidate code on
the host. Cargo.lock resolution and all subsequent checks execute in the worker.
The engine captures every selected dependency identity after this trusted edit,
then rejects source/revision changes, removal, aliases, or new Cargo overrides.

Use `closed_pr_policy: skip` for one PR per release; use `new-pr` for a rolling
update branch after a previous PR closes/merges. Existing open PRs and orphan
branches are resumed; rebases fail on conflicts. Main/PR changes require a retry.
The publisher rebuilds its index, validates the actual commit tree, and pushes
with an explicit expected-head lease. It does not copy worker Git metadata.
Existing submodule pointers stay frozen to main and are not initialized in the
worker; workspaces requiring their contents need a separate reviewed extension.

## STS

Use a caller policy with immutable owner/repository IDs, its credential environment
subject, its main workflow identity, and the shared workflow's reviewed revision:

```yaml
subject: repo:example@<owner-id>/service@<repo-id>:environment:dependency-updates
claim_pattern:
  workflow_ref: example/service/\.github/workflows/update-sdk\.yml@refs/heads/main
  job_workflow_ref: tempoxyz/gh-actions/\.github/workflows/dependency-update\.yml@<shared-sha>
permissions:
  contents: write
  pull_requests: write
max_ttl: 15m
```

The App installation must grant those permissions without branch-rule bypass.
The environment is in the caller repository; configure its secrets/protection
there. An environment `AMP_API_KEY` overrides the explicitly forwarded repository
secret if both exist. No stored GitHub token or extra STS Actions permission is
needed: reads use the caller's read-scoped `GITHUB_TOKEN`, and each short publishing
phase exchanges a fresh STS token, revoked before returning to repair. The STS
implementation comes from the same revision as the shared workflow. Cleanup is
best effort on abrupt runner loss; minted tokens have a maximum 15-minute TTL.

## Results and migration

Outputs: `pull-request-number`, `pull-request-url`, `head-sha`, and `status`
(`skipped`, `passed`, `failed`). CI requires completed successful runs for every
configured workflow on the candidate SHA; stale/empty/running runs are not green.
Failures use the latest run attempt's logs. A timed-out/no-op/exhausted repair
fails and retains an existing PR; a valid best-effort local patch can be published
for review even when its local checks still fail. Unsafe patches are never pushed.
Do not infer invariant correctness from CI success. Local commits use the STS bot
identity; this initial publisher does not provide GitHub server-side signatures.

Start with a caller-approved worker image and repository adapter, then run manual
dispatch with merging disabled. For a moving upstream branch, keep a rolling PR
and benchmark/audit jobs after this workflow. For stable releases, select a release
and its compatible transitive revision and use one branch per release. Add source
review and any merge policy in the caller, respecting existing branch rules.

Tests use synthetic repositories and credentials. Live Docker/Amp/STS/GitHub
integration requires a configured caller and is not exercised by the unit suite.
