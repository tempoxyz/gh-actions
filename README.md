# gh-actions

Reusable GitHub Actions for the Tempo organization.

## Actions

| Action | Description |
|--------|-------------|
| [`osv-scanner-action`](actions/osv-scanner-action) | Scan dependencies and compare vulnerabilities with OSV |
| [`actionlint`](actions/actionlint) | Lint GitHub Actions workflows with the digest-pinned actionlint image
| [`docker-login`](actions/docker-login) | Log in to GHCR and optionally Docker Hub
| [`docker-build-push`](actions/docker-build-push) | Build and push Docker images
| [`docker-metadata-tags`](actions/docker-metadata-tags) | Standard Tempo Docker tagging strategy
| [`cosign-sign`](actions/cosign-sign) | Sign container images with cosign
| [`publish-event`](actions/publish-event) | POST webhook events to downstream systems
| [`cloudflare-sts`](actions/cloudflare-sts) | Exchange GitHub OIDC tokens for short-lived Cloudflare API tokens with automatic cleanup
| [`github-sts`](actions/github-sts) | Exchange GitHub OIDC tokens for short-lived GitHub App tokens
| [`secure-runner`](actions/secure-runner) | Start Harden Runner and install Socket Firewall with short-lived credentials
| [`ensure-secure-runner`](actions/ensure-secure-runner) | Fail unless every workflow job starts with the `secure-runner` action
| [`harden-runner`](actions/harden-runner) | Start Harden Runner with authenticated StepSecurity policy-store access, falling back to the inline policy on fork pull requests or when no StepSecurity credential can be obtained
| [`socket-sts`](actions/socket-sts) | Exchange GitHub OIDC tokens for short-lived Socket API tokens
| [`socket-firewall`](actions/socket-firewall) | Install Aegis with a short-lived, repository-scoped Socket token, or warn and skip installation when setup fails
| [`create-pull-request`](actions/create-pull-request) | Commit working-tree changes and open a PR
| [`pr-audit-comment`](actions/pr-audit-comment) | Handle PR audit issue-comment commands
| [`setup-rust-build`](actions/setup-rust-build) | Install Rust toolchain, mold linker, and sccache
| [`setup-foundry`](actions/setup-foundry) | Install Foundry toolchain from an attested release
| [`setup-argo-cli`](actions/setup-argo-cli) | Install Argo Workflows CLI from a signature-verified release
| [`setup-pinact`](actions/setup-pinact) | Install pinact from an attested release
| [`setup-terraform`](actions/setup-terraform) | Install Terraform verified against HashiCorp's signed checksums
| [`setup-helm`](actions/setup-helm) | Install Helm verified against the maintainers' GPG signatures
| [`cargo-cooldown`](actions/cargo-cooldown) | Reject crates.io dependencies newer than the configured cooldown

### Installer verification

Every tool these actions and workflows download is verified with the strongest proof its
publisher offers, in addition to a checksum; a checksum from the same release cannot detect a
release that was compromised end to end. The only accepted reason to skip a check is a large
wall-clock cost.

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
| [`JasonEtco/create-an-issue`](https://github.com/JasonEtco/create-an-issue) | v2.9.2 (`1b14a70`) | Creates a new issue using a template with front matter. |
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
| [`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request/blob/5f6978faf089d4d20b00c7766989d076bb2fc7f1/README.md) | v8.1.1 (`5f6978f`) | Creates a pull request for changes to your repository in the actions workspace |
| [`planetscale/setup-pscale-action`](https://github.com/planetscale/setup-pscale-action/blob/b6a50ee45b4b24944e1d8de6e57b3a5f6476a1af/README.md) | v1 (`b6a50ee`) | Installs the PlanetScale CLI |
| [`pnpm/action-setup`](https://github.com/pnpm/action-setup/blob/0977fd99725f1db4007ccb2928dbb4e90d06cc86/README.md) | v6.0.10 (`0977fd9`) | Install pnpm package manager |
| [`ruby/setup-ruby`](https://github.com/ruby/setup-ruby/blob/95ef2b042f9d7a56d8268cba8559e2842e2ad01b/README.md) | v1.321.0 (`95ef2b0`) | Download a prebuilt Ruby and add it to the PATH in 5 seconds |
| [`rust-lang/crates-io-auth-action`](https://github.com/rust-lang/crates-io-auth-action/blob/c6f97d42243bad5fab37ca0427f495c86d5b1a18/README.md) | v1.0.5 (`c6f97d4`) | Retrieve a temporary crates.io access token using trusted publishing. |
| [`shallwefootball/upload-s3-action`](https://github.com/shallwefootball/upload-s3-action/blob/4350529f410221787ccf424e50133cbc1b52704e/README.md) | v1.3.3 (`4350529`) | Upload directory to S3 |
| [`sigstore/cosign-installer`](https://github.com/sigstore/cosign-installer/blob/6f9f17788090df1f26f669e9d70d6ae9567deba6/README.md) | v4.1.2 (`6f9f177`) | Installs cosign and includes it in your path |
| [`step-security/harden-runner`](https://github.com/step-security/harden-runner/blob/e14015d583714f6e62063499dc959a02595150a1/README.md) | v2.21.1 (`e14015d`) | Harden-Runner provides runtime security for GitHub-hosted and self-hosted runners |
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

### Secure runner

Use `secure-runner` as the first step in a job. It uses the production STS endpoints by default.
For a development deployment, set `step-security-sts-host: ss-sts.tempoxyz.dev` and/or
`socket-sts-host: socket-sts.tempoxyz.dev`.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Secure runner
        uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>

      - uses: actions/checkout@<commit-sha>

      - run: make test
```

The default fallback egress policy is `audit`. Set `egress-policy: block` and, if needed,
`allowed-endpoints` for workflows that should fail closed when no stored policy applies.
The nested Harden Runner wrapper performs its STS exchange in its pre-job entrypoint before starting Harden Runner,
because Harden Runner fetches its policy in its own pre-job entrypoint. The short-lived API key is
passed only to the vendored Harden Runner process and is revoked during post-job cleanup.

## Versioning

Examples in this repo use `@main` for brevity. **For production, pin to a full commit SHA** — branch refs like `@main` are mutable, and the bundled `scan-github-actions` workflow flags unpinned uses. Every commit merged to `main` receives an annotated timestamp tag. Use that tag in the trailing comment; Pinact requires it and verifies that it resolves to the pinned SHA:

```yaml
uses: tempoxyz/gh-actions/actions/setup-rust-build@<commit-sha> # 2026-09-21T18-36-40Z
```

The SHA is the immutable reference; the timestamp comment records the reviewed, tagged release.

## Reusable Workflows

| Workflow | Description | Source |
|----------|-------------|--------|
| [`pr-audit`](#pr-audit) | Publish a `pr_audit` event when a PR is labeled (read-only) | tempo, zones |
| [`label-prs`](#label-prs) | Label new PRs from their linked issue | tempo, zones |
| [`scan-github-actions`](#scan-github-actions) | Security scan, lint, and optional action pin policy checks | any |
| [`dependency-scan`](#dependency-scan) | Detect newly introduced dependency vulnerabilities with OSV | Linux, macOS, Windows |
| [`reproducible-build`](#reproducible-build) | Reproducible build verification | tempo |
| [`reproducible-image-verify`](#reproducible-image-verify) | Compare a Depot candidate image's binary with an independent clean rebuild | zones |
| [`reproducible-eif-verify`](#reproducible-eif-verify) | Compare independently built unsigned Nitro EIF measurements | zones |
| [`rust-lint`](#rust-lint) | Shared Rust clippy, fmt, typos, and deny checks | rust repos |
| [`rust-deny`](#rust-deny) | Deny-only wrapper around rust-lint | rust repos |
| [`rust-fmt`](#rust-fmt-and-rust-clippy) | Formatting-only wrapper around rust-lint | rust repos |
| [`rust-clippy`](#rust-fmt-and-rust-clippy) | Clippy-only wrapper around rust-lint | rust repos |
| [`rust-build-binaries`](#rust-build-binaries) | Build Rust binaries and upload artifacts | rust repos |
| [`cargo-update-pr`](#cargo-update-pr) | Open a scheduled `cargo update` PR | tempo |
| [`auto-assign-pr`](#auto-assign-pr) | Auto-assign the author to their PR | tempo |

Reference reusable workflows using `tempoxyz/gh-actions/.github/workflows/<name>.yml@main` (pin to a commit SHA in production — see [Versioning](#versioning)).

### `pr-audit`

Publishes a `pr_audit` event when a pull request receives a configured label. This reusable workflow is **read-only** against repository contents. Comment-driven audit commands are handled separately by the [`pr-audit-comment`](actions/pr-audit-comment) composite action in a caller-owned job (see below).

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
        startsWith(github.event.comment.body, 'cyclops private audit') ||
        startsWith(github.event.comment.body, '@decofe cyclops audit') ||
        startsWith(github.event.comment.body, '@decofe cyclops private audit') ||
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
          command-regex: '^(?:@decofe\s+)?(?:cyclops\s+(?:private\s+)?audit|derek\s+audit)\b'
          permission-check-mode: association
          allowed-associations: OWNER,MEMBER
          organization: tempoxyz
          events-key: ${{ secrets.EVENTS_KEY }}
          events-cert: ${{ secrets.EVENTS_CERT }}
          events-args: ${{ secrets.EVENTS_ARGS }}
          github-token: ${{ github.token }}
```

The comment surface supports:

- comments: `cyclops audit`, `cyclops private audit`, `@decofe cyclops audit`, `derek audit`
- arguments: `private`, `fast`, `perf`, `iterations=N`, `hours=N`, `config=PATH`, `models=...`, `run-label=LABEL`, `dry-run`, `note="..."`

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

The dedicated `scan-github-actions-ci.yml` caller runs on pull requests and pushes to `main` in this repository, scanning `.github actions` with actionlint and pinact enabled. This includes the secure-runner policy check; CI does not invoke a separate scan or policy-check job. The reusable workflow only declares `workflow_call`.

Security scan and lint for GitHub Actions workflows: [zizmor](https://github.com/zizmorcore/zizmor) for security and [actionlint](https://github.com/rhysd/actionlint) (with shellcheck/pyflakes) for workflow syntax and `run:` script correctness. Findings appear as GitHub workflow annotations and in the workflow log. The lint pass can be turned off with `actionlint: false`.

Set `pinact: true` to also run [pinact](https://github.com/suzuki-shunsuke/pinact) in check-only mode. This enforces a default seven-day minimum age for pinned action commits, requires a trailing tag comment, and verifies that the tag resolves to the pinned SHA. Caller-local Pinact configuration is merged on top of the trusted default source and can override its threshold; callers that need an exception can set `verify-pin-comments: false`. Existing callers remain unchanged because the pinact check is opt-in.

zizmor, actionlint, and the optional pinact policy run together in a single **Scan GitHub Actions** check. The reusable workflow is read-only against repository and Actions data and never requests `security-events: write`. To upload SARIF to GitHub code scanning, use the [composite action](actions/scan-github-actions) with `advanced-security: true` in a job you control (see its README).

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
    with:
      pinact: true
```

For required-check setup and recovery from missing scans, see [Required status checks](actions/scan-github-actions/README.md#required-status-checks). Callers grant `id-token: write` for secure-runner OIDC authentication; no STS URL secret is needed.

To skip the secure-runner presence check entirely, including its annotations and summary, set:

```yaml
with:
  ensure-secure-runner: false
```

This controls the presence checker, not the secure-runner action that protects the scan job.

The secure-runner presence check fails on violations by default. To keep its reports without
blocking CI, set:

```yaml
with:
  secure-runner-fail-on-violation: false
```

This only makes the presence check advisory: violation annotations and the summary remain,
including the checker's existing error annotations and final warning. Existing Aegis and
StepSecurity steps, zizmor, actionlint, and Pinact are unchanged. Missing secure-runner steps
will no longer block CI, so newly unprotected jobs can pass. Checker setup failures (such as
missing workflow paths) still fail.

By default zizmor scans the whole repo, so first-party workflows and actions anywhere (e.g. across a monorepo) are covered. Repos that vendor third-party workflows/actions can narrow zizmor's scope with the `paths` input (e.g. to `.github/`) to avoid flagging code they don't own. Pinact uses its own file discovery; monorepos with action manifests outside its defaults can set `files` in their Pinact configuration.

Optional inputs:

- `paths` (default: `.`) — whitespace-separated paths for zizmor to scan; narrow to e.g. `.github/` to exclude vendored or third-party trees
- `config` — path to a [zizmor config file](https://docs.zizmor.sh/usage/#configuration) for rule overrides. When empty, zizmor discovers a repository configuration when present.
- `actionlint` (default: `true`) — run actionlint (syntax, expression, and shellcheck/pyflakes checks) alongside the zizmor scan
- `ensure-secure-runner` (default: `true`) — set `false` to skip the presence check, including its annotations and summary
- `secure-runner-fail-on-violation` (default: `true`) — set `false` to report missing/misplaced/conditional secure-runner steps without failing the check
- `pinact` (default: `false`) — run pinact policy checks alongside zizmor and actionlint
- `pin-config` (default: `.pinact.yaml`) — path to the caller repo's pinact configuration file; the default is optional when absent
- `pin-no-api` (default: `false`) — perform offline pin validation without API-based comment or minimum-age verification
- `verify-pin-comments` (default: `true`) — require a tag comment and verify that it resolves to the pinned SHA; set `false` for a repository-specific exception
- `verify-pin-min-age` (default: `true`) — verify current pins against configured minimum-age rules
- `pin-min-age` (default: `7`) — default minimum age in days for pinned action commits; caller-local Pinact configuration can override it

### `dependency-scan`

**Dependency Scan** scans base and proposed revisions with our
[`osv-scanner-action`](actions/osv-scanner-action), then compares results to find
new vulnerabilities. Works on private repositories without GitHub Code Security or
Advanced Security. Uses Tempo-owned actions and GitHub’s `actions/checkout` and `actions/upload-artifact`.
Native OSV binaries are installed from GitHub releases and verified against pinned
checksums and SLSA provenance. Docker and Go are not required; the action uses Node.js
20+ for installation and reporting on Linux, macOS, and Windows.

```yaml
name: Dependency Scan

on:
  pull_request:
  merge_group:

permissions: {}

jobs:
  scan:
    uses: tempoxyz/gh-actions/.github/workflows/dependency-scan.yml@main
    permissions:
      contents: read
      id-token: write
```

Pin production callers to a full commit SHA. The dedicated
`dependency-scan-ci.yml` caller runs this workflow on this repository's
pull requests and merge groups on Linux, macOS, and Windows. It starts with `secure-runner`; the OIDC permission
is for runner protection, and no GitHub/OIDC credentials are forwarded to the native child processes.

By default, scans compare the event's base SHA with its merge SHA, including the
proposed merge result. Other events require both `base-ref` and `head-ref`;
`pull_request_target` and `workflow_run` are rejected. Both checkouts disable
credential persistence. Results live in an isolated runner temporary directory that survives switching
revisions. Native scans use the runner’s filesystem permissions; there is no
container or read-only mount.

New vulnerabilities fail the job by default. Existing findings are baselined using
OSV's occurrence-count and source/package/advisory comparison semantics. `fail-on-vuln: false` makes findings informational;
scanner failures and missing or malformed results still fail. A revision with no
supported dependency files is allowed and produces an empty inventory, so a PR
can introduce its first lockfile or remove its last one. OSV-supported lockfiles,
SBOMs, and manifests are scanned; unresolved or unsupported dependencies are not
an assurance of safety. Call analysis is disabled.

Results appear as annotations and in the job summary. Base/head JSON, diff JSON,
Markdown, and SARIF are retained together as an Actions artifact for five days,
including when the vulnerability gate fails. Nothing is uploaded to Code Scanning,
and no `security-events: write` or `pull-requests: write` permission is required.

| Input | Default | Description |
|-------|---------|-------------|
| `scan-args` | `--recursive` then `./` | One source scan argument per line; format/output/call-analysis flags are managed internally |
| `fail-on-vuln` | `true` | Fail on newly introduced vulnerabilities |
| `base-ref`, `head-ref` | Event base/merge SHAs | Explicit revision overrides |
| `checkout-submodules` | `false` | Recursively check out submodules |
| `runs-on` | `ubuntu-latest` | Linux, macOS, or Windows runner with Node.js 20+ |
| `timeout-minutes` | `20` | Job timeout |
| `artifact-name` | `dependency-scan` | Set a unique name for each matrix invocation |

The `vulnerabilities-found` workflow output is `true` or `false` after a completed
comparison. Configure OSV exclusions with `osv-scanner.toml` or `scan-args`; each
revision's scanner configuration applies to its scan.

Migration from `dependency-review.yml`: change the workflow path and required
status check names, remove old inputs/secrets, and remove `pull-requests: write`.
The old workflow defaulted to warning only; use `fail-on-vuln: false` to retain
that behavior. License policy, package deny lists, Scorecard, PR comments, and the
old action's JSON outputs are not carried over. Previously SHA-pinned callers
continue using the old implementation until their pins are updated.

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

Caller workflows must grant `contents: read` so the reusable workflow can check out the repository being built.

Required input:

- `binary-name` — name of the binary produced in `out/`

Optional inputs:

- `ref` — Git ref to check out
- `target` (default: `x86_64-unknown-linux-gnu`)
- `build-script` (default: `./scripts/reproducible-build.sh`)
- `runs-on` (default: `depot-ubuntu-latest-16`)
- `retention-days` (default: `7`)

### `reproducible-image-verify`

Resolves one source commit, builds and pushes a candidate through Depot, rebuilds
without Docker cache on a separate GitHub-hosted runner, and compares the binary
extracted from the candidate's immutable image digest. A mismatch fails the run.
Verification covers the selected binary, not the complete container or an EIF.

Keep the Dockerfile, Bake target, and executable build script in the caller's
repository. The workflow checks out the requested source and overlays the listed
recipe files from a separate trusted commit. Include every recipe/helper needed
by both builds in `build-definition-paths`; paths must name regular files, not
directories or symlinks. The script must honor `NO_CACHE=1` and `VERSION`, and write
the binary at `rebuild-output`. Bake receives `SOURCE_DATE_EPOCH`, `GIT_SHA`, and
`VERSION` from the resolved source commit.

```yaml
jobs:
  verify:
    # Keep publishing restricted to an explicitly dispatched, trusted workflow.
    if: >-
      github.event_name == 'workflow_dispatch' &&
      github.repository == 'tempoxyz/zones' &&
      github.ref == 'refs/heads/main'
    uses: tempoxyz/gh-actions/.github/workflows/reproducible-image-verify.yml@main
    permissions:
      contents: read
      packages: write
      id-token: write
    with:
      ref: ${{ inputs.ref || github.sha }}
      build-definitions-sha: ${{ github.workflow_sha }}
      build-definition-paths: |
        .dockerignore
        docker/Dockerfile.reproducible
        docker/docker-bake.hcl
        scripts/reproducible-build.sh
      depot-project: 0c6tg19qsp
      candidate-repository: ghcr.io/tempoxyz/tempo-zone-repro
      bake-file: docker/docker-bake.hcl
      bake-target: tempo-zone-reproducible
      binary-path: /usr/local/bin/tempo-zone
      rebuild-output: out/tempo-zone
```

Pin the shared workflow to a reviewed full SHA in production. The caller controls
triggers, repository/branch restrictions, and permission grants. Use a dedicated
non-production GHCR repository; the workflow creates `run-<id>-<attempt>-<sha>`
tags. Depot must authorize the caller's OIDC identity, and the caller's token must
have access to that GHCR package. No additional secrets are required.

Optional inputs are `build-script` (default `scripts/reproducible-build.sh`),
`candidate-runner` (default `depot-ubuntu-latest-16`), `artifact-name` (default
`reproducible-candidate-binary-verification`), and `retention-days` (default `7`).
Choose distinct artifact names and candidate repositories for multiple calls in
one run. The clean rebuild always uses a fresh `ubuntu-latest` runner.

Outputs are `source-sha`, `candidate-image-digest`, `candidate-tag`, and
`binary-sha256`. Dependent jobs should run only when verification succeeds.
The JSON artifact records both checksums, the image digest, source commit, trusted
recipe commit, shared workflow commit, and comparison result. Download it and
check `binary_comparison_result == "success"` and
`depot_sha256 == clean_build_sha256`. Extraction failures and mismatches also
upload a diagnostic manifest; failures before the comparison job do not.

### `reproducible-eif-verify`

Builds an unsigned Nitro EIF through Depot and again without Docker cache on a
fresh GitHub-hosted runner. A third job runs `nitro-cli describe-eif` on both
uploaded EIFs, validates their CRCs, and requires identical PCR0/PCR1/PCR2.
The full-file SHA-256 values and `byte_identical` result are recorded separately:
EIF metadata can differ without changing the measured enclave payload.
This verifies build artifacts, not a deployed enclave or the EIF in a release image.

The caller owns the build recipes and supplies an immutable toolchain image
containing Nitro CLI, the guest kernel, NSM module, and bootstrap utilities. Both
builds and the comparison use that exact image digest. Toolchain reproducibility
itself is outside this comparison. An extra build input (for example, genesis
JSON) is downloaded independently in each build and must match a supplied SHA-256.

```yaml
jobs:
  verify-eif:
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'
    uses: tempoxyz/gh-actions/.github/workflows/reproducible-eif-verify.yml@main
    permissions:
      contents: read
      packages: read
      id-token: write
    with:
      ref: ${{ inputs.ref || github.sha }}
      build-definitions-sha: ${{ github.workflow_sha }}
      build-definition-paths: |
        .dockerignore
        docker/Dockerfile.reproducible
        scripts/reproducible-eif-build.sh
      build-script: scripts/reproducible-eif-build.sh
      eif-builder-image: ${{ inputs.eif_builder_image }} # image@sha256:<64 hex digits>
      build-input-url: ${{ inputs.genesis_url }}
      build-input-sha256: ${{ inputs.genesis_sha256 }}
      depot-project: your-depot-project
```

Pin the shared workflow to a reviewed full SHA. Restrict dispatch and recipe
selection to a trusted workflow. Source refs resolve once, and both builds overlay
the listed regular files from `build-definitions-sha`; include every build helper.
The caller needs read access to the toolchain registry and Depot OIDC authorization.

The executable build script receives these environment variables:

| Variable | Contract |
| --- | --- |
| `BUILD_BACKEND` | `depot` for the candidate, `docker` for the independent rebuild |
| `NO_CACHE` | `0` for Depot, `1` for the clean rebuild; the script must honor it |
| `DEPOT_PROJECT` | Caller-supplied Depot project |
| `GIT_SHA`, `SOURCE_DATE_EPOCH` | Resolved source commit and its commit timestamp |
| `EIF_BUILDER_IMAGE` | Toolchain pinned by registry digest |
| `BUILD_INPUT_FILE` | Absolute path to the verified downloaded input |
| `OUT_DIR` | Absolute output directory; write `enclave.eif` here |

Optional inputs are `candidate-runner` (default `depot-ubuntu-latest-16`),
`artifact-name` (default `reproducible-eif-verification`), and `retention-days`
(default `7`). Use distinct artifact names for multiple calls in one run.
Artifacts `<artifact-name>-depot` and `<artifact-name>-docker` contain the EIFs;
`<artifact-name>` contains `manifest.json` and both raw Nitro descriptions.

Require `comparison_result == "success"` in the manifest. It records source,
recipe and shared workflow revisions, the toolchain digest, input checksum, both
EIF checksums and PCR measurements. Build or comparison failures fail the workflow;
the comparison attempts to upload diagnostics even if one build failed.
Outputs are `source-sha`, `candidate-eif-sha256`, `rebuild-eif-sha256`, `pcr0`, `pcr1`,
and `pcr2`. Consume measurement outputs only after successful verification.

### `rust-lint`

Runs a common Rust lint set: `cargo clippy`, `cargo fmt`, `typos`, and `cargo deny`.
All checks run by default and can be enabled or disabled independently.

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
      id-token: write
```

Optional inputs:

- `run-clippy`, `run-fmt`, `run-typos`, `run-deny` (default: `true`) — enable each check independently
- `rust-toolchain` (default: `nightly`) — used for clippy and fmt
- `deny-rust-toolchain` (default: `stable`) — installed on the deny runner and used inside the cargo-deny container
- `clippy-flags` (default: `--all-targets --all-features --locked`)
- `fmt-flags` (default: `--all --check`)
- `deny-flags` (default: `--all-features`)
- `checkout-submodules` (default: `false`) — passed to clippy checkout only
- `clippy-runner`, `fmt-runner`, `typos-runner`, `deny-runner`, `timeout-minutes`

For individual checks, use [`rust-deny`](#rust-deny),
[`rust-fmt`, or `rust-clippy`](#rust-fmt-and-rust-clippy).

The deny action runs in Docker and manages its own Rust toolchain;
`deny-rust-toolchain` is forwarded to its `rust-version` input. Callers grant `contents: read`
for checkout and `id-token: write` for Harden Runner OIDC/STS authentication.
Pin production callers to a commit SHA (see [Versioning](#versioning)).

The `lint success` gate accepts explicitly disabled checks and fails on failures,
cancellations, or unexpected skips. If all four checks are disabled, only the
gate runs and succeeds.

### `rust-deny`

Runs `cargo deny check all` through `rust-lint.yml` at the same commit, with clippy,
fmt, and typos disabled internally. It shares the existing Harden Runner setup,
checkout, Rust installation, cargo-deny container, and `lint success` gate.

```yaml
jobs:
  deny:
    uses: tempoxyz/gh-actions/.github/workflows/rust-deny.yml@main
    permissions:
      contents: read
      id-token: write
    with:
      rust-toolchain: nightly
```

Optional inputs:

- `rust-toolchain` (default: `stable`) — installed on the runner and used inside the cargo-deny container
- `flags` (default: `--all-features`) — additional flags passed to `cargo deny check all`
- `runner` (default: `ubuntu-latest`)
- `timeout-minutes` (default: `30`) — timeout for each job, including the success gate

The example explicitly selects nightly; omitting `with` uses stable. Callers must
grant both permissions shown above; no persistent StepSecurity API key is required.
Pin production callers to a commit SHA (see [Versioning](#versioning)). The additional
workflow nesting can change displayed check names, so verify required status checks
when switching an existing caller from `rust-lint`.

### `rust-fmt` and `rust-clippy`

Run only formatting or Clippy through `rust-lint.yml` at the same commit, sharing
its STS-backed Harden Runner and success gate. Other checks are disabled internally.
Clippy also retains the shared mold/sccache setup and warnings-as-errors policy.

```yaml
jobs:
  fmt:
    uses: tempoxyz/gh-actions/.github/workflows/rust-fmt.yml@main
    permissions:
      contents: read
      id-token: write
  clippy:
    uses: tempoxyz/gh-actions/.github/workflows/rust-clippy.yml@main
    permissions:
      contents: read
      id-token: write
```

Both accept `rust-toolchain` (default `nightly`), `runner` (default `ubuntu-latest`),
`timeout-minutes` (default `30`), and `flags`. Formatting defaults to `--all --check`;
Clippy defaults to `--all-targets --all-features --locked`. Clippy additionally accepts
`checkout-submodules` (default `"false"`). Use Linux runners supported by the shared
Harden Runner setup; Clippy's mold installer requires Linux.

Pin production callers to a commit SHA. Preserve existing cooldown prerequisites
with `needs`, explicitly carry over custom flags, and update required check names
if nesting changes them. Both permissions shown above are required for checkout
and STS authentication; no persistent StepSecurity API key is needed.

### `rust-build-binaries`

Builds one or more Rust binaries with `cargo build --locked --bin <binary> --profile <profile>` and uploads each binary as an artifact. Callers must commit an up-to-date `Cargo.lock`; the build fails if it is missing or dependency resolution would change it.

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
