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
| [`setup-rust-build`](actions/setup-rust-build) | Install Rust toolchain, mold linker, and sccache | tempo |
| [`setup-foundry`](actions/setup-foundry) | Install Foundry toolchain | tempo |
| [`setup-argo-cli`](actions/setup-argo-cli) | Install Argo Workflows CLI | helm-charts |
| [`scan-github-actions`](actions/scan-github-actions) | Security scan for GitHub Actions workflows | any |

## Usage

Reference actions using `tempoxyz/gh-actions/actions/<name>@main`:

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

Pin to `@main` for latest, or tag releases (`@v1`, `@v1.0.0`) for stability.

## Reusable Workflows

Reference reusable workflows using `tempoxyz/gh-actions/.github/workflows/<name>.yml@main`.

### `pr-audit`

Publishes a `pr_audit` event when a pull request receives a configured label.

```yaml
name: PR Audit

on:
  pull_request:
    types: [labeled]

jobs:
  pr-audit:
    uses: tempoxyz/gh-actions/.github/workflows/pr-audit.yml@main
    secrets: inherit
```

Optional input:

- `required-label` (default: `cyclops`)

### `scan-github-actions`

Security scan for GitHub Actions workflows (powered by [zizmor](https://github.com/zizmorcore/zizmor)). By default, findings appear as GitHub workflow annotations and in the workflow log; SARIF upload is disabled. Repositories with GitHub code scanning enabled can opt into SARIF upload with `advanced-security: true`.

```yaml
name: Scan GitHub Actions

on:
  push:
    branches: [main]
  pull_request:

jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
```

Enable SARIF upload only in repositories with code scanning enabled:

```yaml
jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    with:
      advanced-security: true
    permissions:
      actions: read
      contents: read
      security-events: write
```

Optional input:

- `config` — path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides
- `advanced-security` (default: `false`) — upload SARIF to GitHub code scanning and disable workflow annotations

### `rust-lint`

Runs the common Rust lint set used by Tempo repositories: `cargo clippy`, `cargo fmt`, `typos`, and `cargo deny`.

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

Zones can use the shared workflow without the old Foundry setup:

```yaml
jobs:
  lint:
    uses: tempoxyz/gh-actions/.github/workflows/rust-lint.yml@main
    with:
      rust-toolchain: nightly-2026-02-21
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
