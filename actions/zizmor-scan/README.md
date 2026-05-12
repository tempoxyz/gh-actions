# Zizmor Scan

Run [zizmor](https://github.com/zizmorcore/zizmor) static analysis on GitHub Actions workflows to detect security issues such as template injection, credential leakage, excessive permissions, and more.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `inputs` | Paths to scan (whitespace-separated) | No | `.` |
| `persona` | Auditing persona: `regular`, `pedantic`, or `auditor` | No | `regular` |
| `min-severity` | Minimum severity to report | No | `""` |
| `min-confidence` | Minimum confidence to report | No | `""` |
| `online-audits` | Whether to run online audits | No | `true` |
| `advanced-security` | Upload SARIF results to GitHub Advanced Security | No | `true` |
| `config` | Path to a custom zizmor configuration file | No | `""` |
| `version` | Zizmor version to install | No | `latest` |
| `token` | GitHub token for online audits | No | `${{ github.token }}` |

## Usage

### As a composite action

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: tempoxyz/gh-actions/actions/zizmor-scan@main
```

### Via the reusable workflow

```yaml
name: Zizmor

on:
  push:
    branches: [main]
  pull_request:

jobs:
  zizmor:
    uses: tempoxyz/gh-actions/.github/workflows/zizmor.yml@main
```
