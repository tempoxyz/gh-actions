# Cargo cooldown

Install [`cargo-cooldown` 0.3.4](https://crates.io/crates/cargo-cooldown/0.3.4) and reject
workspace dependency graphs containing registry releases newer than the configured cooldown, which
defaults to seven days.

The action runs `cargo cooldown --workspace --all-features check` with fail-closed policy:

- `incompatible-publish-age = "deny"` rejects a graph when Cargo requires a fresh version.
- `lockfile-baseline = "ignore"` checks versions already present in `Cargo.lock`, rather than
  treating them as trusted. This protects the consumption of a lockfile that already contains a
  fresh release.
- `git diff --exit-code -- Cargo.lock` fails when `cargo-cooldown` finds a safe downgrade, so the
  changed lockfile must be reviewed and committed separately.

The workspace must contain a committed `Cargo.lock`. The tool and its installer are version-pinned;
the vendored installer verifies release checksums before executing the downloaded binary.

## Configuration

The action sets the global minimum publish age from `cooldown-days` and enforces the fail-closed
settings above. Put exceptions and registry-specific policy in `<workspace-root>/cooldown.toml`:

```toml
[[allow.exact]]
crate = "example"
version = "1.2.3"

[[allow.package]]
crate = "internal-example"
min-publish-age = "1 day"
```

The action environment fixes the default global cooldown, incompatible-publish-age policy, and
lockfile baseline. More-specific registry settings and explicit allow rules in `cooldown.toml` can
intentionally reduce that policy for selected dependencies.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `cooldown-days` | Minimum whole days since a registry release was published | No | `7` |
| `working-directory` | Cargo workspace to check | No | `.` |
| `verbose` | Enable verbose `cargo-cooldown` output | No | `false` |

## Usage

Check out the repository and install its Rust toolchain before invoking the action:

```yaml
jobs:
  cargo-cooldown:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<full-commit-sha>
        with:
          persist-credentials: false
      - uses: tempoxyz/gh-actions/vendor/dtolnay/rust-toolchain@<full-commit-sha>
      - uses: tempoxyz/gh-actions/actions/cargo-cooldown@<full-commit-sha>
```

`cargo-cooldown` validates the graph with Cargo and runs `cargo check` only after fresh versions
have been removed or rejected. Run one required gate job per workflow and make jobs that consume
the workspace dependency graph depend on it. Downstream Cargo commands should still use `--locked`
so they cannot resolve a different graph after the gate.

The action does not protect a later `cargo install`, which resolves a separate dependency graph.
