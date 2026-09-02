# gh-actions

Reusable GitHub Actions for the Tempo organization.

## Actions

| Action | Description |
|--------|-------------|
| [`docker-login`](actions/docker-login) | Log in to GHCR and optionally Docker Hub
| [`docker-build-push`](actions/docker-build-push) | Build and push Docker images
| [`docker-metadata-tags`](actions/docker-metadata-tags) | Standard Tempo Docker tagging strategy
| [`cosign-sign`](actions/cosign-sign) | Sign container images with cosign
| [`publish-event`](actions/publish-event) | POST webhook events to downstream systems
| [`github-sts`](actions/github-sts) | Exchange GitHub OIDC tokens for short-lived GitHub App tokens
| [`socket-firewall`](actions/socket-firewall) | Install Socket Firewall with a short-lived, repository-scoped token
| [`create-pull-request`](actions/create-pull-request) | Commit working-tree changes and open a PR
| [`pr-audit-comment`](actions/pr-audit-comment) | Handle PR audit issue-comment commands
| [`setup-rust-build`](actions/setup-rust-build) | Install Rust toolchain, mold linker, and sccache
| [`setup-foundry`](actions/setup-foundry) | Install Foundry toolchain from an attested release
| [`setup-argo-cli`](actions/setup-argo-cli) | Install Argo Workflows CLI from a signature-verified release
| [`setup-pinact`](actions/setup-pinact) | Install pinact from an attested release
| [`setup-terraform`](actions/setup-terraform) | Install Terraform verified against HashiCorp's signed checksums
| [`setup-helm`](actions/setup-helm) | Install Helm verified against the maintainers' GPG signatures

### Installer verification

Every tool these actions and workflows download is verified with the strongest proof its
publisher offers, in addition to a checksum; a checksum from the same release cannot detect a
release that was compromised end to end. The only accepted reason to skip a check is a large
wall-clock cost.

| Tool | Where | Proof | How it is checked |
|------|-------|-------|-------------------|
| pinact | `setup-pinact`, `scan-github-actions` | GitHub artifact attestation (SLSA provenance) | `gh attestation verify`, pinned to pinact's release workflow and the requested tag |
| Foundry | `setup-foundry` | GitHub artifact attestation (SLSA provenance) | `gh attestation verify`, pinned to Foundry's release workflow and the resolved tag or `master` |
| Argo CLI | `setup-argo-cli` | cosign signature on the checksums file, fixed key | `openssl dgst -verify` with the key pinned in the action |
| Terraform | `setup-terraform` | GPG signature on `SHA256SUMS` by the HashiCorp Security key | `gpg --verify` in a throwaway keyring holding only the pinned key |
| Helm | `setup-helm` | GPG signature per archive by a maintainer in Helm's `KEYS` file | `gpg --verify` against the pinned `KEYS` keyring |
| typos | `typos`, `rust-lint` | GitHub release attestation (immutable release) | `gh release verify-asset` |
| mold | `setup-mold`, `setup-rust-build`, `rust-build-binaries`, `rust-lint` | none published | tarball SHA-256 pinned in the step |
| cosign | `cosign-sign` (via `sigstore/cosign-installer`) | checksum embedded in the pinned action | verified by the action |
| sccache | `setup-rust-build`, `rust-build-binaries` (via `mozilla-actions/sccache-action`) | `.sha256` from the same release only | verified by the action |
| zizmor | `scan-github-actions` (via `zizmorcore/zizmor-action`) | container image digest embedded in the pinned action | verified by the action |
| [`scan-github-actions`](actions/scan-github-actions) | Security scan (zizmor) + lint (actionlint) for GitHub Actions workflows
| [`setup-mold`](actions/setup-mold) | Install the mold linker from a digest-pinned release
| [`typos`](actions/typos) | Spell-check with typos, installed from an attested release
| [`cargo-install`](actions/cargo-install) | `cargo install` a tool with the binary cached
| [`check-needs`](actions/check-needs) | Gate job: fail unless every needed job succeeded (allowed skips/failures)
| [`changed-paths`](actions/changed-paths) | One boolean output per named path filter for the changed files
| [`pr-comment`](actions/pr-comment) | Create or update one marker-identified PR/issue comment
| [`gh-release`](actions/gh-release) | Create or update a GitHub release and upload assets
| [`slack-notify`](actions/slack-notify) | Post a JSON payload to a Slack API method or webhook

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

Examples in this repo use `@main` for brevity. **For production, pin to a full commit SHA** — branch refs like `@main` are mutable, and the bundled `scan-github-actions` workflow flags unpinned uses. Add a trailing reference comment; the optional pinact policy check requires one for bare SHA pins, and it also improves readability:

```yaml
uses: tempoxyz/gh-actions/actions/setup-rust-build@<commit-sha> # main
```

This repo does not yet publish version tags; SHA pinning is the recommended stable reference.

## Reusable Workflows

| Workflow | Description | Source |
|----------|-------------|--------|
| [`pr-audit`](#pr-audit) | Publish a `pr_audit` event when a PR is labeled (read-only) | tempo, zones |
| [`label-prs`](#label-prs) | Label new PRs from their linked issue | tempo, zones |
| [`scan-github-actions`](#scan-github-actions) | Security scan, lint, and optional action pin policy checks | any |
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
      required-labels: |
        cyclops
        agentic-audit
    secrets:
      EVENTS_KEY: ${{ secrets.EVENTS_KEY }}
      EVENTS_CERT: ${{ secrets.EVENTS_CERT }}
      EVENTS_ARGS: ${{ secrets.EVENTS_ARGS }}
```

Optional inputs:

- `required-label` — label that triggers audit publishing (default: `cyclops`); kept for compatibility
- `required-labels` — comma or newline-separated labels that trigger audit publishing; when set, this overrides `required-label`
- `environment` — GitHub Environment name, such as `pr-audit`, used to gate audit publishing
- `branch` / `pr-number` — target for ad-hoc `workflow_dispatch` callers
- `require-completed-audit` — publish a `Cyclops audit run` merge-gate status (default: `false`)

When `require-completed-audit: true`, internal and non-Dependabot pull requests remain pending until `tempoxyz-bot` posts a completed Cyclops review; fork and Dependabot pull requests are exempt. Completed reviews remain valid after later commits. The caller must add `pull_request_target`, `pull_request_review`, and `merge_group` triggers, grant `pull-requests: read` and `statuses: write`, and require the resulting `Cyclops audit run` status on the protected branch. Reusable workflows cannot declare caller event triggers.

```yaml
on:
  pull_request:
    types: [labeled]
  pull_request_target: # zizmor: ignore[dangerous-triggers]
    types: [opened, reopened, synchronize, labeled, unlabeled]
  pull_request_review:
    types: [submitted]
  merge_group:

jobs:
  pr-audit:
    uses: tempoxyz/gh-actions/.github/workflows/pr-audit.yml@main
    permissions:
      contents: read
      pull-requests: read
      statuses: write
    with:
      require-completed-audit: true
    secrets:
      EVENTS_KEY: ${{ secrets.EVENTS_KEY }}
      EVENTS_CERT: ${{ secrets.EVENTS_CERT }}
      EVENTS_ARGS: ${{ secrets.EVENTS_ARGS }}
```

Repos that need protected environment gates, such as Zones' `environment: pr-audit` gate for `EVENTS_*`, should pass `environment: pr-audit` so the publish job preserves that approval boundary.

#### Comment-command audits (opt-in, privileged)

Because comment handling needs `issues: write` and `pull-requests: read`, it lives in a caller-owned job that runs the [`pr-audit-comment`](actions/pr-audit-comment) composite action rather than in the read-only reusable workflow. Add it alongside the label job:

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
    if: >-
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      (
        startsWith(github.event.comment.body, 'cyclops audit') ||
        startsWith(github.event.comment.body, '@decofe cyclops audit') ||
        startsWith(github.event.comment.body, 'derek audit')
      )
    runs-on: ubuntu-latest
    environment: pr-audit
    permissions:
      contents: read
      issues: write
      pull-requests: read
    steps:
      - uses: tempoxyz/gh-actions/actions/pr-audit-comment@main
        with:
          command-regex: '^(?:@decofe\s+)?(?:cyclops\s+audit|derek\s+audit)\b'
          permission-check-mode: association
          allowed-associations: OWNER,MEMBER
          organization: tempoxyz
          events-key: ${{ secrets.EVENTS_KEY }}
          events-cert: ${{ secrets.EVENTS_CERT }}
          events-args: ${{ secrets.EVENTS_ARGS }}
          github-token: ${{ github.token }}
```

The comment surface supports:

- comments: `cyclops audit`, `@decofe cyclops audit`, `derek audit`
- arguments: `fast`, `perf`, `iterations=N`, `hours=N`, `config=PATH`, `models=...`, `run-label=LABEL`, `dry-run`, `note="..."`

Set `permission-check-mode: org` (with `organization`) for org-membership API
checks. Use `permission-token` when those checks need a token distinct from the
one used for PR reads and status comments:

```yaml
          permission-check-mode: org
          organization: tempoxyz
          github-token: ${{ secrets.DEREK_BENCH_TOKEN }}
          permission-token: ${{ secrets.DEREK_BENCH_ACK_TOKEN }}
```

If `permission-token` is omitted, membership checks use `github-token` as
before. In `association` mode, `allowed-associations` controls which GitHub
commenter associations may trigger an audit. It defaults to
`OWNER,MEMBER,COLLABORATOR`. In both permission modes, authorization applies to
the commenter, not the pull request author, so a trusted commenter can audit a
pull request from an external fork. `allow-same-author` is deprecated, has no
effect, and remains accepted only for compatibility with existing callers.

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
```

Caller workflows must grant these permissions on the reusable-workflow job. `contents: read` is needed to check out `tempoxyz/gh-actions`; `issues: write` reads issue labels and adds labels to the pull request through GitHub's Issues API.

The reusable workflow checks out `tempoxyz/gh-actions` at `github.workflow_sha`, so the bundled label script matches the pinned reusable workflow revision.

### `scan-github-actions`

Security scan and lint for GitHub Actions workflows: [zizmor](https://github.com/zizmorcore/zizmor) for security and [actionlint](https://github.com/rhysd/actionlint) (with shellcheck/pyflakes) for workflow syntax and `run:` script correctness. Findings appear as GitHub workflow annotations and in the workflow log. The lint pass can be turned off with `actionlint: false`.

Set `pinact: true` to also run [pinact](https://github.com/suzuki-shunsuke/pinact) in check-only mode. This enforces a default seven-day minimum age for pinned action commits and adds optional version-comment verification without editing files or adding a second reusable-workflow job. Caller-local Pinact configuration is merged on top of the trusted default source and can override its threshold, so repository configuration remains review-sensitive. Existing callers remain unchanged because the pinact check is opt-in.

zizmor, actionlint, and the optional pinact policy run together in a single **Scan GitHub Actions** check. The reusable workflow is **read-only** (`actions: read`, `contents: read`) and never requests `security-events: write`, so callers only grant read scopes. To upload SARIF to GitHub code scanning, use the [composite action](actions/scan-github-actions) with `advanced-security: true` in a job you control (see its README).

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
    with:
      pinact: true
```

By default zizmor scans the whole repo, so first-party workflows and actions anywhere (e.g. across a monorepo) are covered. Repos that vendor third-party workflows/actions can narrow zizmor's scope with the `paths` input (e.g. to `.github/`) to avoid flagging code they don't own. Pinact uses its own file discovery; monorepos with action manifests outside its defaults can set `files` in their Pinact configuration.

Optional inputs:

- `paths` (default: `.`) — whitespace-separated paths for zizmor to scan; narrow to e.g. `.github/` to exclude vendored or third-party trees
- `config` — path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides. When empty and the repository has no zizmor config of its own, the scan uses a default that disables zizmor's `ref-version-mismatch` audit: this repository publishes no version tags, so a version comment on a pin to it can never match and every such pin would otherwise be a medium-severity finding that fails the scan. Comment correctness for third-party pins is covered by pinact's `verify-pin-comments`. Add a `.github/zizmor.yml` to a repo to take back full control.
- `actionlint` (default: `true`) — run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan
- `pinact` (default: `false`) — run pinact policy checks alongside zizmor and actionlint
- `pin-config` (default: `.pinact.yaml`) — path to the caller repo's pinact configuration file; the default is optional when absent
- `pin-no-api` (default: `false`) — perform offline pin validation without API-based comment or minimum-age verification
- `verify-pin-comments` (default: `false`) — verify that semver version comments resolve to the pinned SHA
- `verify-pin-min-age` (default: `true`) — verify current pins against configured minimum-age rules
- `pin-min-age` (default: `7`) — default minimum age in days for pinned action commits; caller-local Pinact configuration can override it

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
- `profile` — Cargo build profile

Optional inputs:

- `rust-toolchain` (default: `stable`)
- `runs-on` (default: `depot-ubuntu-latest-16`)
- `checkout-submodules` (default: `false`)
- `artifact-path-template` (default: `target/{profile}/{binary}`)
- `retention-days` (default: `7`)
- `timeout-minutes` (default: `60`)

### `cargo-update-pr`

Runs `cargo update` and opens or updates a pull request for `Cargo.lock`. The
branch push and PR use a short-lived GitHub App token minted via
[`github-sts`](actions/github-sts) — the built-in `GITHUB_TOKEN` is not
allowed to create pull requests.

```yaml
jobs:
  cargo-update-pr:
    uses: tempoxyz/gh-actions/.github/workflows/cargo-update-pr.yml@main
    permissions:
      contents: read
      id-token: write
```

The calling repository must carry a trust policy at
`.github/sts/cargo-update-pr.sts.yaml` that grants its own workflow
`contents: write` and `pull_requests: write`, for example:

```yaml
subject: repo:tempoxyz@<org-id>/<repo>@<repo-id>:ref:refs/heads/main
permissions:
  contents: write
  pull_requests: write
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
