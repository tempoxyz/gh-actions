# Scan GitHub Actions

Security scan **and** lint for GitHub Actions workflows. Runs three complementary checks:

- [ensure-secure-runner](../ensure-secure-runner) — **hardening** (reusable workflow only): every workflow job must start with the [`secure-runner`](../secure-runner) action (Harden Runner plus Socket Firewall). Reusable-workflow calls are allowed; nothing else is exempt.
- [zizmor](https://github.com/zizmorcore/zizmor) — **security**: template injection, credential leakage, excessive permissions, unpinned actions, and more.
- [actionlint](https://github.com/rhysd/actionlint) — **correctness/lint**: workflow syntax, `${{ }}` expression checks, and [shellcheck](https://github.com/koalaman/shellcheck)/[pyflakes](https://github.com/PyCQA/pyflakes) on `run:` scripts.

Both tools run together as a single check (a `Scan GitHub Actions` job in the reusable workflow, or two steps in your own job with the composite action). The **reusable workflow is read-only against Actions and repository data** (`actions: read`, `contents: read`) and never requests `security-events: write`. Callers grant `id-token: write` for secure-runner OIDC authentication; no STS URL secret is needed. SARIF upload to GitHub code scanning is available **only via the composite action** (`advanced-security: true`), which runs in a job you control and where you grant `security-events: write`.

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
  merge_group:
  workflow_dispatch:

permissions: {}

jobs:
  scan:
    name: Scan GitHub Actions
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    permissions:
      actions: read
      contents: read
      id-token: write
```

Disable the lint pass or point zizmor at a custom config:

```yaml
jobs:
  scan:
    name: Scan GitHub Actions
    uses: tempoxyz/gh-actions/.github/workflows/scan-github-actions.yml@main
    with:
      actionlint: false            # zizmor only
      config: .github/zizmor.yml   # zizmor rule overrides
    permissions:
      actions: read
      contents: read
      id-token: write
```

The reusable workflow runs Pinact policy checks by default. Set `pinact: false` only for a repository-specific exception. It requires a trailing tag comment on every SHA pin and verifies that the tag resolves to that SHA; set `verify-pin-comments: false` only for a repository-specific exception. Pinact uses its own file discovery rather than the zizmor `paths` input; set `files` in the caller's Pinact configuration when its action manifests are outside Pinact's defaults. The global minimum age is an overrideable default, so caller-local configuration remains review-sensitive.

### Required status checks

The examples above emit `Scan GitHub Actions / Scan GitHub Actions`: the caller
job name followed by the reusable workflow job name. Require that exact check
from the GitHub Actions app, and preserve both names when updating callers.
Confirm the emitted name on a completed run before changing a ruleset.

Keep `pull_request` unfiltered when this check is required. Workflow-level
`paths` or `paths-ignore` filters prevent a run from being created for some PRs,
leaving the required check pending indefinitely. The reusable workflow cannot
report a result when its caller never starts. Run on source-only and docs-only
PRs too; `with.paths` limits scanner input without suppressing the check.
Include `merge_group` for repositories using a merge queue.
See GitHub's [required status check guidance](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

`workflow_dispatch` is useful for diagnostics, but its checks do **not** satisfy
PR required status checks, even when dispatched on the PR's head commit.
To unblock an existing PR, remove the caller's PR filters and trigger a new
`pull_request` run. If the fix lands on the default branch separately, bring it
into the PR branch and push the updated branch. Confirm that the PR-triggered
scan reports the required check successfully before merging.

For a diagnostic scan on a branch:

```sh
gh workflow run scan-github-actions.yml --repo OWNER/REPO --ref PR_BRANCH
```

The caller must declare `workflow_dispatch` on the default branch. Rerunning an
unrelated CI workflow does not create a missing scanner run.

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
| `paths` | Whitespace-separated paths for zizmor to scan. Defaults to the whole repo, covering first-party workflows and actions anywhere (e.g. across a monorepo). Narrow it (e.g. to `.github/`) to exclude vendored or third-party trees | `.` | reusable + composite |
| `config` | Path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides | `""` | reusable + composite |
| `actionlint` | Run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan | `true` | reusable + composite |
| `pinact` | Run Pinact policy checks alongside zizmor and actionlint | `true` | reusable only |
| `pin-config` | Path to the caller repository's Pinact configuration; the default path is optional when absent | `.pinact.yaml` | reusable only |
| `pin-no-api` | Perform offline pin validation without API-based comment or minimum-age verification | `false` | reusable only |
| `verify-pin-comments` | Require tag comments and verify that they resolve to the pinned SHA; set `false` for a repository-specific exception | `true` | reusable only |
| `verify-pin-min-age` | Verify current pins against configured minimum-age rules | `true` | reusable only |
| `pin-min-age` | Overrideable default minimum age in days for pinned action commits | `7` | reusable only |
| `advanced-security` | Upload SARIF to GitHub code scanning and disable workflow annotations. Requires a public repo, or a private/internal repo with GitHub Advanced Security, plus `security-events: write` on the calling job | `false` | composite only |
