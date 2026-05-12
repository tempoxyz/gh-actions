# Scan GitHub Actions

Security scan for GitHub Actions workflows using [zizmor](https://github.com/zizmorcore/zizmor). Detects template injection, credential leakage, excessive permissions, unpinned actions, and more.

**Opinionated defaults** — online audits enabled, results uploaded to GitHub Advanced Security, regular persona. Override individual rules via a `zizmor.yml` config file if needed.

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
```

### Composite action

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: tempoxyz/gh-actions/actions/scan-actions@main
```

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `paths` | Paths to scan (whitespace-separated) | `.` |
| `config` | Path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides | `""` |
