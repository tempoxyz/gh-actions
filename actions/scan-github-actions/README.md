# Scan GitHub Actions

Security scan **and** lint for GitHub Actions workflows. Runs two complementary tools:

- [zizmor](https://github.com/zizmorcore/zizmor) — **security**: template injection, credential leakage, excessive permissions, unpinned actions, and more.
- [actionlint](https://github.com/rhysd/actionlint) — **correctness/lint**: workflow syntax, `${{ }}` expression checks, and [shellcheck](https://github.com/koalaman/shellcheck)/[pyflakes](https://github.com/PyCQA/pyflakes) on `run:` scripts.

Both tools run together as a single check (a `Scan GitHub Actions` job in the reusable workflow, or two steps in your own job with the composite action). The **reusable workflow is read-only** (`actions: read`, `contents: read`) and never requests `security-events: write`. SARIF upload to GitHub code scanning is available **only via the composite action** (`advanced-security: true`), which runs in a job you control and where you grant `security-events: write`.

**Opinionated defaults** — zizmor online audits enabled, GitHub workflow annotations enabled, regular persona, and SARIF upload disabled; actionlint enabled. Disable the lint pass with `actionlint: false`. Override individual zizmor rules via a `zizmor.yml` config file, and actionlint rules via `.github/actionlint.yaml`, if needed.

## Usage

> Examples use `@main` for brevity. In production, pin `tempoxyz/gh-actions` to a commit SHA — `@main` is mutable and will be flagged by this action's own unpinned-uses check. See [Versioning](../../README.md#versioning).

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

## Inputs

| Name | Description | Default | Available in |
|------|-------------|---------|--------------|
| `paths` | Whitespace-separated paths for zizmor to scan. Defaults to the repo's own workflows and `.github/actions`, excluding vendored/third-party trees. Set to `.` to scan the whole repo, or add first-party action directories (e.g. `.github actions`) | `.github/` | reusable + composite |
| `config` | Path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides | `""` | reusable + composite |
| `actionlint` | Run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan | `true` | reusable + composite |
| `advanced-security` | Upload SARIF to GitHub code scanning and disable workflow annotations. Requires a public repo, or a private/internal repo with GitHub Advanced Security, plus `security-events: write` on the calling job | `false` | composite only |
