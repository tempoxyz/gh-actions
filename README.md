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

Security scan for GitHub Actions workflows. Findings appear as inline annotations on PRs.

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

Optional inputs:

- `paths` — paths to scan (default: `.`)
- `config` — path to a config file for rule overrides
