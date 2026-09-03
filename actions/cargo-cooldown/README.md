# Cargo cooldown

Install [`cargo-cooldown` 0.3.4](https://crates.io/crates/cargo-cooldown/0.3.4) and reject
workspace dependency graphs containing registry releases newer than the configured cooldown, which
defaults to seven days.

By default, the action runs
`cargo cooldown metadata --all-features --locked --format-version 1 --no-deps` with fail-closed
policy. Cargo metadata resolves the whole workspace by default. Set `mode: check` to run
`cargo cooldown --workspace --all-features check --locked` after the same policy guard.

- `incompatible-publish-age = "deny"` rejects a graph when Cargo requires a fresh version.
- `lockfile-baseline = "ignore"` checks versions already present in `Cargo.lock`, rather than
  treating them as trusted. This protects the consumption of a lockfile that already contains a
  fresh release.
- `git diff --exit-code HEAD -- Cargo.lock` fails when `cargo-cooldown` finds a safe downgrade, so the
  changed lockfile must be reviewed and committed separately.

The workspace must contain a committed `Cargo.lock`. The tool version and release archives are
verified against SHA-256 digests pinned in this action before the downloaded binary is executed.
The installer supports x86-64 and ARM64 Linux and macOS runners, plus x86-64 Windows runners.

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
| `mode` | Validation mode: `metadata` or `check` | No | `metadata` |
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

In `metadata` (default) mode, `cargo-cooldown` validates the complete workspace dependency graph
without compiling it, then forwards a minimal `cargo metadata --locked` command. In `check` mode,
it runs `cargo check --locked` only after fresh versions have been removed or rejected. Both modes
apply the same cooldown policy.

The action requires `Cargo.lock` to match `HEAD` before validation and fails if the tool changes it.
Run one required gate job per workflow and make jobs that consume the workspace dependency graph
depend on it. Downstream Cargo commands should still use `--locked` so they cannot resolve a
different graph after the gate.

The action does not protect a later `cargo install`, which resolves a separate dependency graph.
