# gh-actions

Reusable GitHub Actions for the Tempo organization.

## Actions

| Action | Description | Source |
|--------|-------------|--------|
| [`docker-login`](actions/docker-login) | Log in to GHCR and optionally Docker Hub | dev-infra, tempo |
| [`docker-build-push`](actions/docker-build-push) | Build and push Docker images | dev-infra |
| [`docker-metadata-tags`](actions/docker-metadata-tags) | Standard Tempo Docker tagging strategy | tempo |
| [`cosign-sign`](actions/cosign-sign) | Sign container images with cosign | tempo |
| [`publish-event`](actions/publish-event) | POST webhook events to downstream systems | dev-infra, tempo |
| [`label-pr`](actions/label-pr) | Copy eligible labels from a linked issue to a pull request | tempo, zones |
| [`pr-audit-comment`](actions/pr-audit-comment) | Handle PR audit issue-comment commands | tempo, zones |
| [`setup-rust-build`](actions/setup-rust-build) | Install Rust toolchain, mold linker, and sccache | tempo |
| [`setup-foundry`](actions/setup-foundry) | Install Foundry toolchain | tempo |
| [`setup-argo-cli`](actions/setup-argo-cli) | Install Argo Workflows CLI | helm-charts |
| [`scan-github-actions`](actions/scan-github-actions) | Security scan (zizmor) + lint (actionlint) for GitHub Actions workflows | any |

## Usage

Reference actions using `tempoxyz/gh-actions/actions/<name>@main` (pin to a commit SHA in production — see [Versioning](#versioning)):

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-rust-build@main
    with:
      toolchain: stable
      components: clippy,rustfmt

  - uses: tempoxyz/gh-actions/actions/docker-login@main
    with:
      ghcr-token: ${{ secrets.GITHUB_TOKEN }}

  - uses: tempoxyz/gh-actions/actions/publish-event@main
    with:
      url: ${{ secrets.EVENTS_ARGS }}
      event-type: registry_package
      tag: sha-${{ steps.shortsha.outputs.shortsha }}
```

## Versioning

Examples in this repo use `@main` for brevity. **For production, pin to a full commit SHA** — branch refs like `@main` are mutable, and the bundled `scan-github-actions` (zizmor) check flags unpinned uses. Add a trailing comment for readability:

```yaml
uses: tempoxyz/gh-actions/actions/setup-rust-build@<commit-sha> # main
```

This repo does not yet publish version tags; SHA pinning is the recommended stable reference.

## Reusable Workflows

| Workflow | Description | Source |
|----------|-------------|--------|
| [`pr-audit`](#pr-audit) | Publish a `pr_audit` event when a PR is labeled (read-only) | tempo, zones |
| [`label-prs`](#label-prs) | Label new PRs from their linked issue | tempo, zones |
| [`scan-github-actions`](#scan-github-actions) | Security scan for GitHub Actions workflows | any |
| [`reproducible-build`](#reproducible-build) | Reproducible build verification | tempo |
| [`rust-lint`](#rust-lint) | Shared Rust clippy, fmt, typos, and deny checks | rust repos |
| [`rust-build-binaries`](#rust-build-binaries) | Build Rust binaries and upload artifacts | rust repos |
| [`cargo-update-pr`](#cargo-update-pr) | Open a scheduled `cargo update` PR | tempo |
| [`auto-assign-pr`](#auto-assign-pr) | Auto-assign the author to their PR | tempo |

Reference reusable workflows using `tempoxyz/gh-actions/.github/workflows/<name>.yml@main` (pin to a commit SHA in production — see [Versioning](#versioning)).

### `pr-audit`

Publishes a `pr_audit` event when a pull request receives a configured label. This reusable workflow is **read-only** (`contents: read`); comment-driven audit commands are handled separately by the [`pr-audit-comment`](actions/pr-audit-comment) composite action in a caller-owned job (see below).

#### Label audits (read-only)

```yaml
name: PR Audit

on:
  pull_request:
    types: [labeled]

jobs:
  pr-audit:
    uses: tempoxyz/gh-actions/.github/workflows/pr-audit.yml@main
    permissions:
      contents: read
    with:
      environment: pr-audit
    secrets:
      EVENTS_KEY: ${{ secrets.EVENTS_KEY }}
      EVENTS_CERT: ${{ secrets.EVENTS_CERT }}
      EVENTS_ARGS: ${{ secrets.EVENTS_ARGS }}
```

Optional inputs:

- `required-label` — label that triggers audit publishing (default: `cyclops`)
- `environment` — GitHub Environment name, such as `pr-audit`, used to gate audit publishing
- `branch` / `pr-number` — target for ad-hoc `workflow_dispatch` callers

Repos that need protected environment gates, such as Zones' `environment: pr-audit` gate for `EVENTS_*`, should pass `environment: pr-audit` so the publish job preserves that approval boundary.

#### Comment-command audits (opt-in, privileged)

Because comment handling needs `issues: write` and `pull-requests: write`, it lives in a caller-owned job that runs the [`pr-audit-comment`](actions/pr-audit-comment) composite action rather than in the read-only reusable workflow. Add it alongside the label job:

```yaml
on:
  pull_request:
    types: [labeled]
  issue_comment:
    types: [created]

jobs:
  pr-audit:
    uses: tempoxyz/gh-actions/.github/workflows/pr-audit.yml@main
    permissions:
      contents: read
    with:
      environment: pr-audit
    secrets:
      EVENTS_KEY: ${{ secrets.EVENTS_KEY }}
      EVENTS_CERT: ${{ secrets.EVENTS_CERT }}
      EVENTS_ARGS: ${{ secrets.EVENTS_ARGS }}

  pr-audit-comment:
    if: github.event_name == 'issue_comment' && github.event.issue.pull_request
    runs-on: ubuntu-latest
    environment: pr-audit
    permissions:
      contents: read
      issues: write
      pull-requests: write
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

The comment surface supports:

- comments: `cyclops audit`, `@decofe cyclops audit`, `derek audit`
- arguments: `fast`, `iterations=N`, `hours=N`, `config=PATH`, `models=...`, `run-label=LABEL`, `dry-run`, `note="..."`

Set `permission-check-mode: org` (with `organization`) for org-membership API checks, and pass `github-token: ${{ secrets.DEREK_BENCH_TOKEN }}` if you need the Tempo org token behavior.

### `label-prs`

Labels newly opened pull requests by copying eligible labels from the issue linked in the pull request body.

```yaml
name: Label PRs

on:
  pull_request:
    types: [opened]

jobs:
  label-prs:
    uses: tempoxyz/gh-actions/.github/workflows/label-prs.yml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
```

Caller workflows must grant these permissions on the reusable-workflow job. `contents: read` is needed to check out `tempoxyz/gh-actions`; `issues: write` reads issue labels and adds labels; `pull-requests: write` supports PR labeling permissions.

The reusable workflow checks out `tempoxyz/gh-actions` at `github.job_workflow_sha`, so the bundled `label-pr` action matches the pinned reusable workflow revision.

### `scan-github-actions`

Security scan and lint for GitHub Actions workflows: [zizmor](https://github.com/zizmorcore/zizmor) for security and [actionlint](https://github.com/rhysd/actionlint) (with shellcheck/pyflakes) for workflow syntax and `run:` script correctness. Findings appear as GitHub workflow annotations and in the workflow log. The lint pass can be turned off with `actionlint: false`.

zizmor and actionlint run together in a single **Scan GitHub Actions** check. The reusable workflow is **read-only** (`actions: read`, `contents: read`) and never requests `security-events: write`, so callers only grant read scopes. To upload SARIF to GitHub code scanning, use the [composite action](actions/scan-github-actions) with `advanced-security: true` in a job you control (see its README).

```yaml
name: Scan GitHub Actions

on:
  push:
    branches: [main]
  pull_request:

jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    permissions:
      actions: read
      contents: read
```

By default the scan covers the whole repo, so first-party workflows and actions anywhere (e.g. across a monorepo) are covered. Repos that vendor third-party workflows/actions can narrow the scope with the `paths` input (e.g. to `.github/`) to avoid flagging code they don't own.

Optional inputs:

- `paths` (default: `.`) — whitespace-separated paths for zizmor to scan; narrow to e.g. `.github/` to exclude vendored or third-party trees
- `config` — path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides
- `actionlint` (default: `true`) — run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan

### `reproducible-build`

Builds a repository's byte-deterministic binary using `scripts/reproducible-build.sh`, writes a sha256 file, and uploads it as a short-lived artifact.

```yaml
name: Reproducible Build

permissions: {}

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      ref:
        description: "Git ref (branch, tag, or full SHA) to build reproducibly"
        type: string
        required: false
        default: "main"

concurrency:
  group: reproducible-build-${{ github.ref }}-${{ github.event_name }}
  cancel-in-progress: ${{ github.event_name == 'push' }}

jobs:
  build:
    uses: tempoxyz/gh-actions/.github/workflows/reproducible-build.yml@main
    permissions:
      contents: read
    with:
      ref: ${{ inputs.ref }}
      binary-name: tempo
```

Caller workflows must grant `contents: read` on the reusable-workflow job so it can check out the repository being built.

Required input:

- `binary-name` — name of the binary produced in `out/`

Optional inputs:

- `ref` — Git ref to check out
- `target` (default: `x86_64-unknown-linux-gnu`)
- `build-script` (default: `./scripts/reproducible-build.sh`)
- `runs-on` (default: `depot-ubuntu-latest-16`)
- `retention-days` (default: `7`)

### `rust-lint`

Runs a common Rust lint set: `cargo clippy`, `cargo fmt`, `typos`, and `cargo deny`.

```yaml
name: Lint

on:
  push:
    branches: [main]
  pull_request:
  merge_group:

permissions: {}

jobs:
  lint:
    uses: tempoxyz/gh-actions/.github/workflows/rust-lint.yml@main
    permissions:
      contents: read
```

Optional inputs:

- `rust-toolchain` (default: `nightly`) — used for clippy and fmt
- `clippy-flags` (default: `--all-targets --all-features --locked`)
- `fmt-flags` (default: `--all --check`)
- `deny-flags` (default: `--all-features`)
- `checkout-submodules` (default: `false`) — passed to clippy checkout only
- `clippy-runner`, `fmt-runner`, `typos-runner`, `deny-runner`, `timeout-minutes`

### `rust-build-binaries`

Builds one or more Rust binaries with `cargo build --bin <binary> --profile <profile>` and uploads each binary as an artifact.

```yaml
name: Build binaries

on:
  workflow_dispatch:

permissions: {}

jobs:
  build:
    uses: tempoxyz/gh-actions/.github/workflows/rust-build-binaries.yml@main
    permissions:
      contents: read
    with:
      profile: release
      binaries: |
        api-server
        worker
        cli
```

Required input:

- `binaries` — newline-separated binary names to build and upload
- `profile` — Cargo build profile; artifact paths use `debug` when profile is `dev`

Optional inputs:

- `rust-toolchain` (default: `stable`)
- `runs-on` (default: `depot-ubuntu-latest-16`)
- `checkout-submodules` (default: `false`)
- `artifact-path-template` (default: `target/{profile-dir}/{binary}`)
- `retention-days` (default: `7`)
- `timeout-minutes` (default: `60`)

### `cargo-update-pr`

Runs `cargo update` and opens or updates a pull request for `Cargo.lock`.

```yaml
jobs:
  cargo-update-pr:
    uses: tempoxyz/gh-actions/.github/workflows/cargo-update-pr.yml@main
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

Optional inputs:

- `rust-toolchain` (default: `nightly`)
- `title` (default: `chore(deps): weekly cargo update`)

### `auto-assign-pr`

Assigns newly opened or reopened pull requests to their author when the author is an internal collaborator.

```yaml
name: Auto Assign PR to Author

on:
  pull_request:
    types: [opened, reopened]

permissions:
  issues: write
  pull-requests: write

jobs:
  auto-assign:
    uses: tempoxyz/gh-actions/.github/workflows/auto-assign-pr.yml@main
```

Caller workflows must grant `issues: write` and `pull-requests: write`.
