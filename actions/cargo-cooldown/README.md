# Cargo cooldown

Fail when a crates.io dependency in the workspace's committed `Cargo.lock` is newer than the
configured cooldown. The action is implemented in this repository with the Node.js standard
library and does not download or execute a third-party tool.

The action fails closed. A fresh crate, missing or malformed lockfile, Cargo workspace-discovery
failure, unknown registry, or inability to obtain a valid publication timestamp from Cargo's cache
or crates.io makes the action and its job fail. Do not use `continue-on-error` on the gate step or
job.

## Configuration

The cooldown is expressed in whole days and defaults to seven:

```yaml
with:
  cooldown-days: 7
```

Optional exceptions can be committed in `.cargo/cooldown-allowlist.toml`. Prefer an exact
exception for a one-off release. Exact exceptions are applied before cache or network lookup:

```toml
# Temporary bootstrap exception; remove after 2026-09-10.
[[allow.exact]]
crate = "example"
version = "1.2.3"
```

A package-specific cooldown can be used when every release of an internally controlled crate
needs a different policy:

```toml
[[allow.package]]
crate = "another-example"
days = 1
```

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `cooldown-days` | Minimum whole days since a crates.io release was published | No | `7` |
| `working-directory` | Cargo workspace to check | No | `.` |
| `verbose` | Print each crate and publication timestamp | No | `false` |

## Outputs

| Name | Description |
|------|-------------|
| `checked-packages` | Number of crates.io package versions whose publication age was checked |
| `cache-hits` | Number of unique crate lookups served from Cargo's sparse-index cache |
| `remote-fallbacks` | Number of unique crate lookups fetched from `index.crates.io` |
| `exemptions` | Number of package versions exempted before any index lookup |

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

  test:
    needs: cargo-cooldown
    steps:
      - uses: actions/checkout@<full-commit-sha>
        with:
          persist-credentials: false
      - run: cargo test --locked
```

Run one gate job per workflow and make every job that consumes the workspace dependency graph
depend on it. Every downstream Cargo command must use `--locked`; otherwise Cargo can resolve a
different dependency graph after the gate. Repeating the action in every matrix job repeats the
same lockfile and index work.

## Scope

The action runs `cargo locate-project --workspace --frozen` to find the workspace without resolving
its dependencies, then strictly parses every `[[package]]` entry in the root `Cargo.lock`. It does
not download or extract crate archives, clone Git dependencies, or execute dependency code. The
lockfile parser accepts Cargo.lock formats 3 and 4 and fails closed on malformed required fields.

Publication timestamps are read from Cargo's existing sparse-index cache first. A missing,
malformed, unsupported, or incomplete cache entry falls back to the official crates.io sparse
index. On a cold runner this means one bounded sparse-index request per unique crate; restoring
Cargo's registry index cache reduces those fallbacks. The archive and extracted-source caches are
not needed.

Path and Git dependencies are explicitly outside this crates.io publication-age policy. An
unrecognized registry or source format fails closed instead of being silently skipped. Registry
mirrors and private registries are not currently configurable.

This action checks the versions recorded in `Cargo.lock`; it does not prove that `Cargo.lock`
matches the workspace manifests. It deliberately avoids resolving the workspace because Cargo's
full locked resolver can download crates and clone Git dependencies. Consequently, every
downstream workspace Cargo command must use `--locked` so a stale manifest cannot cause Cargo to
resolve unchecked versions after the gate.

The action does not protect a later `cargo install`: that command resolves the installed package
and its packaged lockfile in a separate Cargo invocation. Use a cooldown-aware install action for
that operation rather than assuming this workspace gate applies to it.

Cargo's sparse-index cache is an internal Cargo format rather than a stable API. The action accepts
only the cache format it understands and falls back to crates.io for anything else. A persistent
self-hosted runner must provide a trusted or isolated `CARGO_HOME`, because this action trusts the
same local registry cache that Cargo uses for dependency resolution. GitHub-hosted runners are
ephemeral unless a registry index cache is explicitly restored.

The action has no runtime dependency on another GitHub Action, npm package, or downloaded
executable. Cargo, the Node runtime supplied by GitHub Actions, and access to the crates.io index
for cache misses are required. crates.io is the authoritative data source because a lockfile does
not contain publication timestamps.
