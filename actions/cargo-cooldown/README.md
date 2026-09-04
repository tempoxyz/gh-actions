# Cargo cooldown

Install [`cargo-cooldown` 0.3.4](https://crates.io/crates/cargo-cooldown/0.3.4) and reject
workspace dependency graphs containing registry releases newer than the configured cooldown, which
defaults to seven days.

By default, the action runs
`cargo cooldown --workspace --all-features tree --locked --depth 0` with fail-closed policy.
Set `mode: check` to run
`cargo cooldown --workspace --all-features check --locked` after the same policy guard.

- `incompatible-publish-age = "deny"` rejects a graph when Cargo requires a fresh version.
- `lockfile-baseline = "ignore"` checks versions already present in `Cargo.lock`, rather than
  treating them as trusted. This protects the consumption of a lockfile that already contains a
  fresh release.
- `git diff --exit-code HEAD -- Cargo.lock` fails when `cargo-cooldown` finds a safe downgrade. The
  action restores the original lockfile before exiting, so callers never inherit an unreviewed graph.

The workspace must contain a committed `Cargo.lock`. The tool version, release archives, and
extracted binaries are verified against SHA-256 digests pinned in this action before the binary is
executed directly, without Cargo alias or external-subcommand lookup.
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
lockfile baseline. It removes inherited `COOLDOWN_NOW`, `COOLDOWN_SKIP_REGISTRIES`,
`CARGO_REGISTRY_MIN_PUBLISH_AGE`, and `CARGO_REGISTRIES_*_MIN_PUBLISH_AGE` values before running the
verifier. More-specific registry settings and explicit allow rules in the project `cooldown.toml`
can intentionally reduce that policy for selected dependencies.

By default, the action rejects `$CARGO_HOME/cooldown.toml` because runner-level policy is outside
the reviewed project. Set `allow-user-policy: true` only when that file is an intentional, trusted
part of the runner configuration.

Set `strict-project-config: true` when the project policy must be limited to reviewed exact-version
exceptions. Strict mode requires `<working-directory>/cooldown.toml` to be a regular tracked file
that matches `HEAD`, rejects `allow-user-policy`, and accepts only blank lines, comments, and
complete `[[allow.exact]]` blocks with one `crate` and one `version` field. The intentionally narrow
syntax rejects inline comments, duplicate rules, and every other cargo-cooldown configuration key.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `cooldown-days` | Minimum whole days since a registry release was published | No | `7` |
| `working-directory` | Cargo workspace to check | No | `.` |
| `mode` | Validation mode: `verify` or `check` | No | `verify` |
| `verbose` | Enable verbose `cargo-cooldown` output | No | `false` |
| `allow-user-policy` | Allow policy from `$CARGO_HOME/cooldown.toml` | No | `false` |
| `strict-project-config` | Require tracked, clean, exact-only project policy | No | `false` |

## Outputs

| Name | Description |
|------|-------------|
| `verifier-path` | Absolute path to the checksum-verified `cargo-cooldown` binary |
| `verifier-sha256` | Pinned SHA-256 digest of the installed binary |

These values are action outputs rather than job environment exports. Callers that execute the
verifier later should map the outputs into the exact consuming step, verify the digest again, and
invoke the binary directly. This prevents an intervening process from replacing the trust anchor
through `GITHUB_ENV`.

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
      - id: cargo-cooldown
        uses: tempoxyz/gh-actions/actions/cargo-cooldown@<full-commit-sha>
        with:
          strict-project-config: true
      - name: Use the same verified binary later
        env:
          VERIFIER: ${{ steps.cargo-cooldown.outputs.verifier-path }}
          EXPECTED_SHA256: ${{ steps.cargo-cooldown.outputs.verifier-sha256 }}
        run: |
          echo "$EXPECTED_SHA256  $VERIFIER" | sha256sum --check --strict
          "$VERIFIER" cooldown --workspace --all-features tree --locked --depth 0
```

In `verify` (default) mode, `cargo-cooldown` selects every workspace member, validates its complete
dependency graph without compiling it, then forwards a depth-zero `cargo tree --locked` command.
The explicit `--workspace` also covers non-default members when a workspace configures
`default-members`. In `check` mode, the action runs `cargo check --locked` only after fresh versions
have been removed or rejected. Both modes apply the same cooldown policy.

The action requires `Cargo.lock` to match `HEAD` before validation, fails if the tool changes it,
and restores the original file on exit.
Run one required gate job per workflow and make jobs that consume the workspace dependency graph
depend on it. Downstream Cargo commands should still use `--locked` so they cannot resolve a
different graph after the gate.

The action does not protect a later `cargo install`, which resolves a separate dependency graph.
