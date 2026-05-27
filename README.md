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

Security scan for GitHub Actions workflows (powered by [zizmor](https://github.com/zizmorcore/zizmor)). Findings appear as inline annotations on PRs and in the workflow log. SARIF upload to GitHub Advanced Security is **not** enabled.

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

Optional input:

- `config` — path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides

### `codeql`

Runs CodeQL with the default query suite and a repository-local config file for repo-specific exclusions.

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 6 * * 1"

permissions:
  actions: read
  contents: read
  packages: read
  security-events: write

jobs:
  analyze:
    uses: tempoxyz/gh-actions/.github/workflows/codeql.yml@main
```

Default repo config path:

```yaml
# .github/codeql/codeql-config.yml
name: "CodeQL config"

query-filters:
  - exclude:
      id: rust/rule-id-to-disable
```

Optional inputs:

- `languages` (default: `rust`)
- `config-file` (default: `./.github/codeql/codeql-config.yml`)
- `build-mode` (default: `none`)

### `cargo-deny`

Runs `cargo deny check all`.

```yaml
jobs:
  cargo-deny:
    uses: tempoxyz/gh-actions/.github/workflows/cargo-deny.yml@main
```

Optional inputs:

- `rust-toolchain` (default: `nightly`)
- `deny-flags` (default: `--all-features`)

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
