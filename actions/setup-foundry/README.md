# Setup Foundry

Install the Foundry toolchain (forge, cast, anvil, chisel) from a release whose assets carry SLSA
provenance, without running an installer. `foundry-rs/foundry-toolchain` uses the Rust `foundryup`,
which also verifies the release's Sigstore bundle against Foundry's release workflow; this action
performs that check with `gh attestation verify` instead of downloading `foundryup` itself.

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
`.github/workflows/release.yml`. The action reuses `gh` when it supports the required attestation
flags. Otherwise, on Linux x86_64 or ARM64 it installs GitHub CLI 2.102.1 under `RUNNER_TEMP`,
checks an archive SHA-256 pinned in the action, and verifies the CLI's own provenance before
adding it to `PATH`. No root access or preinstalled `gh` is required; the runner needs Bash,
curl, tar, gzip, sha256sum, mktemp, GNU stat, and GNU timeout. Foundry's checksum and attestation checks still run.

Binaries are installed under `RUNNER_TEMP` and added to `PATH`; `foundryup` itself is not installed.

## Download recovery

Release URLs are retried three times, with a 10-second connection timeout and a low-speed
limit of 1 KiB/s for 60 seconds. The 180-second retry window limits when retries start, not
the duration of a progressing transfer. After a transient HTTP or interrupted network failure,
including a connection failure after a redirect, the action resolves the exact asset by tag
and name through GitHub's official release API and downloads it by ID. API metadata requests
are limited to 30 seconds. The asset transfer has no whole-download deadline; 60 seconds
without observed file growth terminates it (checked each second), with a forced kill after
another 5 seconds if needed.
Partial downloads are never published to the installer, and interrupted API children are reaped.
Missing assets, HTTP or proxy authorization denials, and certificate errors fail without a fallback.

Both routes feed the same mandatory checksum and provenance checks before extraction or PATH
publication. Neither a checksum nor an attestation failure triggers another route or changes the
requested Foundry version. RPC caching is unchanged; it does not cache the downloaded binaries.
