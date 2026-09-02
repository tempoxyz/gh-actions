# Setup Foundry

Install the Foundry toolchain (forge, cast, anvil, chisel) from a release whose assets carry SLSA
provenance. Replaces `foundry-rs/foundry-toolchain`, which runs `foundryup` without verifying what
it downloads.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | `stable` (newest stable release), `nightly` (newest nightly build), a release tag such as `v1.8.1`, or a nightly build tag such as `nightly-<commit>` | No | `stable` |
| `cache` | Cache Foundry's RPC responses (`~/.foundry/cache`) between runs | No | `true` |
| `cache-key` | Custom part of the cache key | No | `${{ github.job }}-${{ github.sha }}` |
| `cache-restore-keys` | Custom part of the cache restore key prefix | No | `${{ github.job }}-` |

## Outputs

| Name | Description |
|------|-------------|
| `tag` | Release tag that was installed, e.g. `v1.8.1` or `nightly-<commit>` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-foundry@main

  - uses: tempoxyz/gh-actions/actions/setup-foundry@main
    with:
      version: nightly
```

## How it verifies

Foundry publishes every stable release as `vX.Y.Z` and every nightly build as its own
`nightly-<commit>` pre-release. Each asset ships with a `.sha256` file and a GitHub artifact
attestation (SLSA provenance signed through Sigstore by `foundry-rs/foundry`'s release workflow).
The rolling `stable` and `nightly` releases are not attested, so `stable` and `nightly` resolve to
the newest tagged release of that kind through the GitHub API.

The action downloads the tarball, checks the `.sha256`, then runs `gh attestation verify` requiring
provenance from `foundry-rs/foundry` at the resolved tag (or `master` for nightlies), signed by
`.github/workflows/release.yml`. `gh` is preinstalled on GitHub-hosted runners; the check adds a
few seconds. Binaries are installed under `RUNNER_TEMP` and added to `PATH`; `foundryup` itself is
not installed.
