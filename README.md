# gh-actions

Reusable GitHub Actions for the Tempo organization.

## Actions

| Action | Description |
|--------|-------------|
| [`actionlint`](actions/actionlint) | Lint GitHub Actions workflows with the digest-pinned actionlint image
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
| actionlint | `actionlint`, `scan-github-actions`, `scan-github-actions.yml` | release tarball digests pinned in the installer (rhysd/actionlint publishes checksums but no attestations) |
| cosign | `cosign-sign` (via `sigstore/cosign-installer`) | checksum embedded in the pinned action | verified by the action |
| sccache | `setup-rust-build`, `rust-build-binaries` (via `mozilla-actions/sccache-action`) | `.sha256` from the same release only | verified by the action |
| zizmor | `scan-github-actions` (via `zizmorcore/zizmor-action`) | container image digest embedded in the pinned action | verified by the action |
| [`scan-github-actions`](actions/scan-github-actions) | Security scan (zizmor) + lint (actionlint) for GitHub Actions workflows
| [`setup-mold`](actions/setup-mold) | Install the mold linker from a digest-pinned release
| [`typos`](actions/typos) | Spell-check with typos, installed from an attested release
| [`cargo-cooldown`](actions/cargo-cooldown) | Reject crates.io dependencies newer than the configured cooldown
| [`cargo-install`](actions/cargo-install) | `cargo install` a tool with the binary cached
| [`check-needs`](actions/check-needs) | Gate job: fail unless every needed job succeeded (allowed skips/failures)
| [`changed-paths`](actions/changed-paths) | One boolean output per named path filter for the changed files
| [`pr-comment`](actions/pr-comment) | Create or update one marker-identified PR/issue comment
| [`gh-release`](actions/gh-release) | Create or update a GitHub release and upload assets
| [`slack-notify`](actions/slack-notify) | Post a JSON payload to a Slack API method or webhook

### 3rd Party Actions

Copies of outside actions, vendored under [`vendor/`](vendor/) so they count as
tempoxyz-owned under the org's Actions policy. Each copy is an exact upstream commit
recorded in [`vendor-manifest.yml`](vendor-manifest.yml); the version column links to the
upstream README at that commit. Reference them as
`tempoxyz/gh-actions/vendor/<owner>/<repo>[/<path>]@<commit-sha>` (see [Versioning](#versioning)),
with the same inputs and outputs as upstream. To add or update one, edit the manifest with
`node vendor/add.mjs owner/repo@<tag>` or bump `ref`/`sha`, run `node vendor/sync.mjs`, and
commit the result; CI fails if `vendor/` or this table drift from the manifest. Details of
what is excluded from each copy and why are in the manifest `notes`.

<!-- vendored-actions:begin -->
| Action | Version | Description |
|--------|---------|-------------|
| [`1password/install-cli-action`](https://github.com/1password/install-cli-action/blob/1a3160d5e9de1ae0803eaa08a88746f5ae3daa50/README.md) | v4.1.0 (`1a3160d`) | Install 1Password CLI in your pipeline |
| [`1password/load-secrets-action`](https://github.com/1password/load-secrets-action/blob/70062d7a876d3eb6334754fa26efd2fbd90c32f2/README.md) | v5.0.1 (`70062d7`) | Make secrets from 1Password Connect available as environment variables in the next steps. |
| [`CodSpeedHQ/action`](https://github.com/CodSpeedHQ/action/blob/f22792bfac16f3e14eb9fbea76f4a48e9cc22b93/README.md) | v4.19.1 (`f22792b`) | Continuous benchmarking and performance checks |
| [`DeterminateSystems/nix-installer-action`](https://github.com/DeterminateSystems/nix-installer-action/blob/ef8a148080ab6020fd15196c2084a2eea5ff2d25/README.md) | v22 (`ef8a148`) | Install Nix with the Determinate Nix Installer. See: https://github.com/DeterminateSystems/nix-installer |
| [`EmbarkStudios/cargo-deny-action`](https://github.com/EmbarkStudios/cargo-deny-action/blob/3c6349835b2b7b196a839186cb8b78e02f7b5f25/README.md) | v2.1.1 (`3c63498`) | Help manage Cargo crate dependencies and validate licenses |
| [`SocketDev/action`](https://github.com/SocketDev/action/blob/be1f253a41351d59095f8d7f1425985097dd1054/README.md) | main (`be1f253`) | GitHub Action to run Socket in CLI or Firewall mode |
| [`Swatinem/rust-cache`](https://github.com/Swatinem/rust-cache/blob/6323deb102c322ba6fcbdcafc7e3dddab59af2b6/README.md) | v2.9.2 (`6323deb`) | A GitHub Action that implements smart caching for rust/cargo projects with sensible defaults. |
| [`amannn/action-semantic-pull-request`](https://github.com/amannn/action-semantic-pull-request/blob/48f256284bd46cdaab1048c3721360e808335d50/README.md) | v6.1.1 (`48f2562`) | Ensure your PR title matches the Conventional Commits spec (https://www.conventionalcommits.org/). |
| [`anchore/sbom-action`](https://github.com/anchore/sbom-action/blob/e22c389904149dbc22b58101806040fa8d37a610/README.md) | v0.24.0 (`e22c389`) | Creates an SBOM (Software Bill Of Materials) from your code and container images |
| [`aquasecurity/setup-trivy`](https://github.com/aquasecurity/setup-trivy/blob/81e514348e19b6112ce2a7e3ecbafe19c1e1f567/README.md) | v0.3.1 (`81e5143`) | Install Trivy binary from release page |
| [`aquasecurity/trivy-action`](https://github.com/aquasecurity/trivy-action/blob/ed142fd0673e97e23eac54620cfb913e5ce36c25/README.md) | v0.36.0 (`ed142fd`) | Scans container images for vulnerabilities with Trivy |
| [`astral-sh/setup-uv`](https://github.com/astral-sh/setup-uv/blob/20cfd1bf945f4377ade1205e4dbc17946fc9a30d/README.md) | v10.0.1 (`20cfd1b`) | Set up your GitHub Actions workflow with a specific version of uv. |
| [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials/blob/e6de054238d6b7531b4efff3b6587d9aade6a06c/README.md) | v6.2.3 (`e6de054`) | Configures AWS credentials for use in subsequent steps in a GitHub Action workflow |
| [`biomejs/setup-biome`](https://github.com/biomejs/setup-biome/blob/9edb642ea71f227041b81b805d3b36421b94529f/README.md) | main (`9edb642`) | Setup the Biome CLI in GitHub Actions |
| [`bullfrogsec/bullfrog`](https://github.com/bullfrogsec/bullfrog/blob/7dee337d4575320b6d8cbe9a56d48d2fb765963a/README.md) | v0.11.1 (`7dee337`) | Block unauthorized outbound traffic (egress) in your Github workflows |
| [`changesets/action`](https://github.com/changesets/action/blob/8488615a623b1b9c987934bb89eae8af6a946ac1/README.md) | v2.1.1 (`8488615`) | A GitHub action to automate releases with Changesets |
| [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action) | v4.0.0 (`ebbaa15`) | Deploy your Cloudflare projects from GitHub using Wrangler |
| [`dblock/create-a-github-issue`](https://github.com/dblock/create-a-github-issue) | v3.4.0 (`a25e69c`) | Creates a new GitHub issue using a template. |
| [`dependabot/fetch-metadata`](https://github.com/dependabot/fetch-metadata/blob/25dd0e34f4fe68f24cc83900b1fe3fe149efef98/README.md) | v3.1.0 (`25dd0e3`) | Extract information from about the dependency being updated by a Dependabot-generated PR |
| [`depot/bake-action`](https://github.com/depot/bake-action/blob/1d58c2668346981089b088b7ef36755b206b20e9/README.md) | v1.13.0 (`1d58c26`) | GitHub Action to build Docker images via Bake with Depot |
| [`depot/build-push-action`](https://github.com/depot/build-push-action/blob/98e78adca7817480b8185f474a400b451d74e287/README.md) | v1.18.0 (`98e78ad`) | Build and push Docker images with Depot |
| [`depot/pull-action`](https://github.com/depot/pull-action/blob/a913e06772c98ecd2361a8cc49bec81592dc6600/README.md) | v1.3.1 (`a913e06`) | Pull images from the Depot ephemeral registry. |
| [`depot/setup-action`](https://github.com/depot/setup-action/blob/91bc8495a33ebfc504ffc89e5674379ccf23c29c/README.md) | v1.7.2 (`91bc849`) | Installs the Depot CLI into the GitHub Actions environment |
| [`docker/build-push-action`](https://github.com/docker/build-push-action/blob/53b7df96c91f9c12dcc8a07bcb9ccacbed38856a/README.md) | v7.3.0 (`53b7df9`) | Build and push Docker images with Buildx |
| [`docker/login-action`](https://github.com/docker/login-action/blob/dbcb813823bdd20940b903addbd779551569679f/README.md) | v4.6.0 (`dbcb813`) | GitHub Action to login against a Docker registry |
| [`docker/metadata-action`](https://github.com/docker/metadata-action/blob/dc802804100637a589fabce1cb79ff13a1411302/README.md) | v6.2.0 (`dc80280`) | GitHub Action to extract metadata (tags, labels) for Docker |
| [`docker/setup-buildx-action`](https://github.com/docker/setup-buildx-action/blob/37fe631027851001ddb9b187196cc803df7f5f0e/README.md) | v4.3.0 (`37fe631`) | Set up Docker Buildx |
| [`docker/setup-docker-action`](https://github.com/docker/setup-docker-action/blob/b2189fbf2a6592b51fee7cdd93ee2bfaeba733db/README.md) | v5.1.0 (`b2189fb`) | Set up Docker for use in GitHub Actions by downloading and installing a version of Docker CE |
| [`docker/setup-qemu-action`](https://github.com/docker/setup-qemu-action/blob/96fe6ef7f33517b61c61be40b68a1882f3264fb8/README.md) | v4.2.0 (`96fe6ef`) | Install QEMU static binaries |
| [`dtolnay/rust-toolchain`](https://github.com/dtolnay/rust-toolchain/blob/4360b52568e2003a75bf9bc1d59f33a8e3fc893c/README.md) | stable (`4360b52`) | Install the Rust toolchain |
| [`expo/expo-github-action`](https://github.com/expo/expo-github-action/blob/eab7a230208c952974db8c3245cfd78402c7b385/README.md) | 9.0.0 (`eab7a23`) | Publish, build or manage your Expo app with GitHub Actions |
| [`google-github-actions/auth`](https://github.com/google-github-actions/auth/blob/7c6bc770dae815cd3e89ee6cdf493a5fab2cc093/README.md) | v3.0.0 (`7c6bc77`) | Authenticate to Google Cloud from GitHub Actions via Workload Identity Federation or service account keys. |
| [`google-github-actions/setup-gcloud`](https://github.com/google-github-actions/setup-gcloud/blob/aa5489c8933f4cc7a4f7d45035b3b1440c9c10db/README.md) | v3.0.1 (`aa5489c`) | Downloads, installs, and configures a Google Cloud SDK environment. Adds the `gcloud` CLI command to the $PATH. |
| [`goreleaser/goreleaser-action`](https://github.com/goreleaser/goreleaser-action/blob/f06c13b6b1a9625abc9e6e439d9c05a8f2190e94/README.md) | v7.2.3 (`f06c13b`) | GitHub Action for GoReleaser, a release automation tool for Go projects |
| [`gradle/actions`](https://github.com/gradle/actions/blob/9c971963bec38e04b3d30dcc455b5382be2fdbfb/README.md) | v6.3.0 (`9c97196`) | A collection of actions for building Gradle projects, as well as generating a dependency graph via Dependency Submission. |
| [`helm/chart-releaser-action`](https://github.com/helm/chart-releaser-action/blob/cae68fefc6b5f367a0275617c9f83181ba54714f/README.md) | v1.7.0 (`cae68fe`) | Host a Helm charts repo on GitHub Pages |
| [`helm/chart-testing-action`](https://github.com/helm/chart-testing-action/blob/6ec842c01de15ebb84c8627d2744a0c2f2755c9f/README.md) | v2.8.0 (`6ec842c`) | Install the Helm chart-testing tool |
| [`imjasonh/setup-crane`](https://github.com/imjasonh/setup-crane/blob/feee3b6bb0d4c68370f256a4502498c9227e5c6b/README.md) | v0.7 (`feee3b6`) | Install and authorize crane |
| [`jakebailey/pyright-action`](https://github.com/jakebailey/pyright-action/blob/8ec14b5cfe41f26e5f41686a31eb6012758217ef/README.md) | v3.0.2 (`8ec14b5`) | Run pyright |
| [`jaxxstorm/action-install-gh-release`](https://github.com/jaxxstorm/action-install-gh-release/blob/25e24d2d23ae098373794ef1d6faecb48ee52da8/README.md) | v3.0.0 (`25e24d2`) | Install binaries from GitHub releases |
| [`jayanta525/github-pages-directory-listing`](https://github.com/jayanta525/github-pages-directory-listing/blob/624ac8c4e56893256d3772f61a88e3b14d54314e/README.md) | v4.0.0 (`624ac8c`) | Github Action to generate directory listing index for Github Pages |
| [`lycheeverse/lychee-action`](https://github.com/lycheeverse/lychee-action/blob/e7477775783ea5526144ba13e8db5eec57747ce8/README.md) | v2.9.0 (`e747777`) | Quickly check links in Markdown, HTML, and text files |
| [`mobile-dev-inc/action-maestro-cloud`](https://github.com/mobile-dev-inc/action-maestro-cloud/blob/34906065ba3e85fd57ed533b178187eefb042aed/README.md) | v2.0.2 (`3490606`) | Upload your app to Maestro Cloud to run your Flows in CI |
| [`mozilla-actions/sccache-action`](https://github.com/mozilla-actions/sccache-action/blob/fc920bf0ec8de6ee65d409111f7ec508035751ba/README.md) | v0.0.11 (`fc920bf`) | Setup sccache action |
| [`openai/codex-action`](https://github.com/openai/codex-action/blob/86365089eb2b84e0a8fb0717b304f8bdcb13b20e/README.md) | v1.12 (`8636508`) | Run `codex exec` with a prompt. |
| [`oven-sh/setup-bun`](https://github.com/oven-sh/setup-bun/blob/0c5077e51419868618aeaa5fe8019c62421857d6/README.md) | v2.2.0 (`0c5077e`) | Download, install, and setup Bun to your path. |
| [`peaceiris/actions-gh-pages`](https://github.com/peaceiris/actions-gh-pages/blob/84c30a85c19949d7eee79c4ff27748b70285e453/README.md) | v4.1.0 (`84c30a8`) | GitHub Actions for GitHub Pages 🚀 Deploy static files and publish your site easily. Static-Site-Generators-friendly. |
| [`planetscale/setup-pscale-action`](https://github.com/planetscale/setup-pscale-action/blob/b6a50ee45b4b24944e1d8de6e57b3a5f6476a1af/README.md) | v1 (`b6a50ee`) | Installs the PlanetScale CLI |
| [`pnpm/action-setup`](https://github.com/pnpm/action-setup/blob/0977fd99725f1db4007ccb2928dbb4e90d06cc86/README.md) | v6.0.10 (`0977fd9`) | Install pnpm package manager |
| [`ruby/setup-ruby`](https://github.com/ruby/setup-ruby/blob/95ef2b042f9d7a56d8268cba8559e2842e2ad01b/README.md) | v1.321.0 (`95ef2b0`) | Download a prebuilt Ruby and add it to the PATH in 5 seconds |
| [`rust-lang/crates-io-auth-action`](https://github.com/rust-lang/crates-io-auth-action/blob/c6f97d42243bad5fab37ca0427f495c86d5b1a18/README.md) | v1.0.5 (`c6f97d4`) | Retrieve a temporary crates.io access token using trusted publishing. |
| [`shallwefootball/upload-s3-action`](https://github.com/shallwefootball/upload-s3-action/blob/4350529f410221787ccf424e50133cbc1b52704e/README.md) | v1.3.3 (`4350529`) | Upload directory to S3 |
| [`sigstore/cosign-installer`](https://github.com/sigstore/cosign-installer/blob/6f9f17788090df1f26f669e9d70d6ae9567deba6/README.md) | v4.1.2 (`6f9f177`) | Installs cosign and includes it in your path |
| [`taiki-e/install-action`](https://github.com/taiki-e/install-action/blob/41049aa56687c35e0afa74eed4f09cec4f9afabf/README.md) | v2.85.2 (`41049aa`) | GitHub Action for installing development tools |
| [`tailscale/github-action`](https://github.com/tailscale/github-action/blob/6cae46e2d796f265265cfcf628b72a32b4d7cade/README.md) | v3.3.0 (`6cae46e`) | Connect your GitHub Action workflow to Tailscale |
| [`tailscale/gitops-acl-action`](https://github.com/tailscale/gitops-acl-action/blob/4105afd651aa659e0eec9031a10360c39fbc0804/README.md) | v1.5.1 (`4105afd`) | Push changes to Tailscale and run ACL tests in CI |
| [`wevm/frog`](https://github.com/wevm/frog/blob/702c4eadefe175a208290a99c36e7f4ac1390e53/README.md) | v1 (`702c4ea`) |  |
| [`zizmorcore/zizmor-action`](https://github.com/zizmorcore/zizmor-action/blob/3dc1ecc9bcb9e94e9b2c709687979e1298497054/README.md) | v0.6.2 (`3dc1ecc`) | Run zizmor from GitHub Actions 🌈 |
<!-- vendored-actions:end -->

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
