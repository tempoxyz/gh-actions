# Dependency update and repair

[`dependency-update.yml`](../../.github/workflows/dependency-update.yml) shares
the mechanical update/repair flow: trusted adapter → lockfile/check/repair loop →
validated PR → exact-head CI/repair loop. Release selection, audit/benchmark
requests, deployment, and auto-merge remain in the caller repository.

## Caller

This is a generic example; replace the SHA/version placeholders with reviewed
releases. Pin the workflow revision and tool versions.

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
      rust-toolchains: |
        1.99.0
        nightly-2026-08-21
      nextest-version: "0.9.127"
      codex-version: "0.162.0"
      native-packages: build-essential pkg-config libssl-dev clang libclang-dev mold
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
      CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}
```

The caller owns scheduling and concurrency. Calls are accepted only from the
`base-branch` input (default `main`) on schedule/manual dispatch; that branch is
also the adapter source and PR base. `runner` defaults to `ubuntu-latest`.
Use an ephemeral Ubuntu runner with Python 3.11+, Node/npm, Git, gh and rustup.
The workflow installs the exact `rust-toolchains` (required, with rustfmt/Clippy),
`nextest-version` (default `0.9.127`) and `codex-version` (default
`0.162.0`). The first Rust toolchain becomes `RUSTUP_TOOLCHAIN`;
explicit `cargo +<toolchain>` commands can select another installed toolchain.
`native-packages` defaults to `build-essential pkg-config libssl-dev clang
libclang-dev mold`; installation uses apt/sudo on the disposable runner.
Codex is installed from the exact `@openai/codex` npm package version and its
platform-specific binary package. Nextest uses the vendored installer.
`codex-model` and `codex-effort` optionally override the CLI/model defaults.
There is no image, registry setup or alternate Docker execution path.

`repair-budget-minutes` (at most 150) bounds checks and repairs; setup runs before
that budget and CI waiting uses the rest of the 180-minute job.
Actions logs report preparation, worker phases, numbered checks/repair attempts,
PR publication and CI waiting. Worker commands emit a 30-second heartbeat without
streaming captured output. Failure messages omit exception payloads; no raw
diagnostic artifacts are uploaded. See [progress logging](../codex-repair/README.md#runner-execution)
for the output policy and verifier build-cache lifetime.
The secret `CODEX_API_KEY` must contain a standard OpenAI API key. Only the
named Codex credential is forwarded to the agent process. A public reusable
workflow runs in the caller's context; private inputs, source, PRs and logs belong
to the caller.
Keep private adapters, prompts and real diagnostic fixtures in that repository.

Codex and dependency build scripts execute directly on the same runner as the
coordinator. Child environments omit GitHub/OIDC credentials and check state is
fresh, but this is **not a credential or filesystem security boundary**. Use
fresh disposable runners without unrelated secrets. See
[runner execution](../codex-repair/README.md#runner-execution) for the trust model,
process cleanup and verification behavior.

## Adapter contract

The caller keeps a tracked, standalone, standard-library Python script on its base branch.
The coordinator copies it outside the candidate and invokes it with Python isolated
mode, so candidate source cannot replace it or supply imports. The adapter gets
only a read-scoped GitHub token, never a publishing token or the Codex key.

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
preserving the selected SHAs, and does not run Cargo or other candidate code.
Cargo.lock resolution executes in a temporary source copy on the runner, from which only Cargo.lock is imported; subsequent checks
verify an unchanged source snapshot.
The engine captures every selected dependency identity after this trusted edit,
then rejects source/revision changes, removal, aliases, or new Cargo overrides.

Use `closed_pr_policy: skip` for one PR per release; use `new-pr` for a rolling
update branch after a previous PR closes/merges. Existing open PRs and orphan
branches are resumed; rebases fail on conflicts. A PR changed by another actor
while the workflow runs requires a retry; a newer base branch does not, because
each commit's parent is the base it was validated against and GitHub tests the
PR against the current base. On resume, everything the rebased branch already
contains is kept, including maintainer fixes outside `allowed-paths` (for
example `deny.toml`); repairs cannot modify those files further.
The publisher rebuilds its index, validates the actual commit tree, and pushes
with an explicit expected-head lease. It does not use candidate Git metadata.
Existing submodule pointers and symlinks stay frozen to the base and are not
exported to the repair directory; workspaces requiring submodule contents need a
separate reviewed extension.

## STS

Use a caller policy with immutable owner/repository IDs, its credential environment
subject, its base-branch workflow identity, and the shared workflow's reviewed revision:

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
there. An environment `CODEX_API_KEY` overrides the explicitly forwarded repository
secret if both exist. No stored GitHub token or extra STS Actions permission is
needed: reads use the caller's read-scoped `GITHUB_TOKEN`, and each short publishing
phase exchanges a fresh STS token, revoked before returning to repair. The STS
implementation comes from the same revision as the shared workflow. Cleanup is
best effort on abrupt runner loss; minted tokens have a maximum 15-minute TTL.

## Results and migration

Outputs: `pull-request-number`, `pull-request-url`, `head-sha`, and `status`
(`skipped`, `passed`, `failed`). CI requires a completed `pull_request` or
`pull_request_target` run for every configured workflow on the candidate SHA,
concluding `success`, `skipped` or `neutral` (GitHub's required-check rules);
stale/empty/running runs are not green.
Failures use the latest run attempt's logs. A timed-out/no-op/exhausted repair
fails and retains an existing PR; a no-op CI repair stops before re-checking or
minting a token. A valid best-effort local patch can be published for review even
when its local checks still fail, but not before Cargo.lock resolves the selected
revisions. Unsafe patches are never pushed. The PR body adds review notes for
changed exact (`=x.y.z`) requirements, changed build scripts, and deleted files.
Do not infer invariant correctness from CI success. Local commits use the STS bot
identity; this initial publisher does not provide GitHub server-side signatures.

Configure tool versions and a repository adapter, then run manual dispatch with
merging disabled. For a moving upstream branch, keep a rolling PR
and benchmark/audit jobs after this workflow. For stable releases, select a release
and its compatible transitive revision and use one branch per release. Add source
review and any merge policy in the caller, respecting existing branch rules.

Tests use synthetic repositories and credentials. The runner smoke job installs
the tools, starts Codex with `--version` (no API calls), and runs Cargo checks on a
small fixture. Live Codex repair/STS/GitHub publication requires a configured caller
and is not exercised by these checks.
