# Scan GitHub Actions

Security scan **and** lint for GitHub Actions workflows. Runs two complementary tools:

- [zizmor](https://github.com/zizmorcore/zizmor) — **security**: template injection, credential leakage, excessive permissions, unpinned actions, and more.
- [actionlint](https://github.com/rhysd/actionlint) — **correctness/lint**: workflow syntax, `${{ }}` expression checks, and [shellcheck](https://github.com/koalaman/shellcheck)/[pyflakes](https://github.com/PyCQA/pyflakes) on `run:` scripts.

Both tools run together as a single check (a `Scan GitHub Actions` job in the reusable workflow, or two steps in your own job with the composite action). The check is read-only by default; `security-events: write` is requested only on the SARIF upload path (`advanced-security: true`).

**Opinionated defaults** — zizmor online audits enabled, GitHub workflow annotations enabled, regular persona, and SARIF upload disabled; actionlint enabled. Repositories with GitHub code scanning enabled can opt into SARIF upload with `advanced-security: true`. Disable the lint pass with `actionlint: false`. Override individual zizmor rules via a `zizmor.yml` config file, and actionlint rules via `.github/actionlint.yaml`, if needed.

## Usage

### Reusable workflow (recommended)

```yaml
name: Scan GitHub Actions

on:
  push:
    branches: [main]
  pull_request:

permissions: {}

jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    permissions:
      actions: read
      contents: read
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

Disable the lint pass or point zizmor at a custom config:

```yaml
jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    with:
      actionlint: false            # zizmor only
      config: .github/zizmor.yml   # zizmor rule overrides
    permissions:
      actions: read
      contents: read
```

### Composite action

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  - uses: tempoxyz/gh-actions/actions/scan-github-actions@main
```

Composite action with SARIF upload:

```yaml
permissions:
  actions: read
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
  - uses: tempoxyz/gh-actions/actions/scan-github-actions@main
    with:
      advanced-security: "true"
```

> For strongest supply-chain hygiene, pin `tempoxyz/gh-actions` to a commit SHA rather than `@main` in consumer workflows.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `config` | Path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides | `""` |
| `advanced-security` | Upload SARIF to GitHub code scanning and disable workflow annotations. Requires code scanning to be enabled for the repository | `false` |
| `actionlint` | Run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan | `true` |
