# Scan GitHub Actions

Security scan for GitHub Actions workflows using [zizmor](https://github.com/zizmorcore/zizmor). Detects template injection, credential leakage, excessive permissions, unpinned actions, and more.

**Opinionated defaults** — online audits enabled, regular persona, and SARIF upload to GitHub Advanced Security. Override individual rules via a `zizmor.yml` config file if needed.

## Usage

### Reusable workflow (recommended)

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
      security-events: write
```

### Composite action

```yaml
steps:
  - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  - uses: tempoxyz/gh-actions/actions/scan-github-actions@main
```

> For strongest supply-chain hygiene, pin `tempoxyz/gh-actions` to a commit SHA rather than `@main` in consumer workflows.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `config` | Path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides | `""` |
