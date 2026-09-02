# Vendored third-party actions

Summary of the actions copied into [`vendor/`](vendor/) from [`vendor-manifest.yml`](vendor-manifest.yml)
as of 2026-09-02. Each is vendored at the newest commit referenced anywhere in the tempoxyz org.
Actions that have since been replaced by first-party equivalents under [`actions/`](actions/) (gate
checks, path filters, PR comments, releases, typos, mold, cargo installs, Slack, actionlint) are no
longer vendored.
Reference them as `tempoxyz/gh-actions/vendor/<owner>/<repo>[/<path>]@<commit-sha>`.

- **Copy** describes how much of the upstream repository was kept. `pruned`: files the analysis
  proved unused at run time were removed (see the entry's `notes` in the manifest). `action.yml only`:
  nothing else in the repository is loaded (inline-shell composites, actions that run a prebuilt
  `docker://` image). `whole repo`: the load set could not be determined, so only the repo-wide
  defaults (docs, images, upstream CI, VCS metadata, source maps) were removed.
- **Files** and **Size** are the vendored copy, uncompressed.

| Action | Version | Type | Copy | Files | Size |
|---|---|---|---|---|---|
| `1password/install-cli-action` | v1.0.0 | Composite | pruned | 4 | 4 KB |
| `anchore/sbom-action` | v0.24.0 | Node | pruned | 7 | 3.3 MB |
| `aquasecurity/setup-trivy` | v0.3.1 | Composite | action.yml only | 3 | 18 KB |
| `aquasecurity/trivy-action` | v0.36.0 | Composite | whole repo | 27 | 189 KB |
| `astral-sh/setup-uv` | v10.0.0 | Node | pruned | 6 | 6.1 MB |
| `aws-actions/configure-aws-credentials` | v6.2.3 | Node | pruned | 6 | 3.7 MB |
| `biomejs/setup-biome` | main | Node | pruned | 6 | 732 KB |
| `changesets/action` | v1.9.0 | Node | pruned | 10 | 1.1 MB |
| `cloudflare/wrangler-action` | v4.0.0 | Node | pruned | 3 | 1.4 MB |
| `CodSpeedHQ/action` | v4.19.1 | Composite | action.yml only | 3 | 14 KB |
| `depot/bake-action` | v1.13.0 | Node | pruned | 6 | 4.8 MB |
| `depot/build-push-action` | v1.18.0 | Node | pruned | 6 | 1.3 MB |
| `depot/pull-action` | v1.3.1 | Node | pruned | 5 | 2 MB |
| `depot/setup-action` | v1.7.2 | Node | pruned | 5 | 1.4 MB |
| `docker/build-push-action` | v7.3.0 | Node | pruned | 6 | 2.7 MB |
| `docker/login-action` | v4.6.0 | Node | pruned | 6 | 2.3 MB |
| `docker/metadata-action` | v6.2.0 | Node | pruned | 6 | 2.9 MB |
| `docker/setup-buildx-action` | v4.3.0 | Node | pruned | 6 | 2 MB |
| `docker/setup-docker-action` | v4.7.0 | Node | pruned | 7 | 2.8 MB |
| `dtolnay/rust-toolchain` | stable | Composite | action.yml only | 3 | 8 KB |
| `EmbarkStudios/cargo-deny-action` | v2.1.1 | Dockerfile | pruned | 6 | 15 KB |
| `expo/expo-github-action` | 9.0.0 | Node | pruned | 13 | 5.4 MB |
| `google-github-actions/auth` | v3.0.0 | Node | pruned | 6 | 1.2 MB |
| `google-github-actions/setup-gcloud` | v3.0.1 | Node | pruned | 5 | 1.3 MB |
| `goreleaser/goreleaser-action` | v6.4.0 | Node | pruned | 7 | 814 KB |
| `helm/chart-releaser-action` | v1.7.0 | Composite | pruned | 4 | 25 KB |
| `helm/chart-testing-action` | v2.8.0 | Composite | whole repo | 8 | 19 KB |
| `imjasonh/setup-crane` | v0.7 | Composite | action.yml only | 3 | 13 KB |
| `jakebailey/pyright-action` | v3.0.2 | Node | pruned | 5 | 290 KB |
| `jayanta525/github-pages-directory-listing` | v4.0.0 | Dockerfile | pruned | 79 | 98 KB |
| `lycheeverse/lychee-action` | v2.9.0 | Composite | pruned | 5 | 21 KB |
| `mobile-dev-inc/action-maestro-cloud` | v2.0.2 | Node | pruned | 5 | 1.8 MB |
| `mozilla-actions/sccache-action` | v0.0.11 | Node | pruned | 6 | 1.2 MB |
| `oven-sh/setup-bun` | v2.2.0 | Node | pruned | 7 | 2.7 MB |
| `peaceiris/actions-gh-pages` | v4.1.0 | Node | pruned | 5 | 730 KB |
| `planetscale/setup-pscale-action` | v1 | Node | pruned | 7 | 638 KB |
| `pnpm/action-setup` | v6.0.10 | Node | pruned | 5 | 1.3 MB |
| `rust-lang/crates-io-auth-action` | v1.0.3 | Node | pruned | 8 | 761 KB |
| `shallwefootball/upload-s3-action` | v1.3.3 | Node | pruned | 4 | 1.2 MB |
| `sigstore/cosign-installer` | v4.1.2 | Composite | action.yml only | 3 | 25 KB |
| `SocketDev/action` | main | Node | pruned | 47 | 1.6 MB |
| `Swatinem/rust-cache` | v2.9.2 | Node | pruned | 10 | 9.2 MB |
| `taiki-e/install-action` | releases/cargo-udeps | Composite | whole repo | 236 | 3.8 MB |
| `tailscale/github-action` | v3.3.0 | Composite | action.yml only | 3 | 19 KB |
| `tailscale/gitops-acl-action` | v1.5.1 | Composite | action.yml only | 3 | 5 KB |
| `wevm/frog` | v1 | Composite | action.yml only | 5 | 28 KB |
| `zizmorcore/zizmor-action` | v0.6.2 | Composite | whole repo | 7 | 13 KB |
