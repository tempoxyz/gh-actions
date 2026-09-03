# Cargo cooldown

Fail when a crates.io dependency in the workspace's committed `Cargo.lock` is newer than the
configured cooldown. The action is implemented in this repository with the Node.js standard
library and does not download or execute a third-party tool.

The action fails closed. A fresh crate, missing lockfile, crates.io index failure, Cargo metadata
failure, or malformed publication timestamp makes the action and its job fail. Do not use
`continue-on-error` on the gate step or job.

## Configuration

The cooldown is expressed in whole days and defaults to seven:

```yaml
with:
  cooldown-days: 7
```

Optional exceptions can be committed in `.cargo/cooldown-allowlist.toml`. Prefer an exact
exception for a one-off release:

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
    # ...
```

Run one gate job per workflow and make every job that consumes the workspace dependency graph
depend on it. Repeating the action in every matrix job repeats the same metadata and index work.

## Scope

The action runs `cargo metadata --locked --all-features`, checks every crates.io package in the
resolved graph, and reads publication timestamps from the official crates.io sparse index. Git
dependencies, path dependencies, and non-crates.io registries are skipped because they do not
have crates.io publication timestamps.

The action has no runtime dependency on another GitHub Action, npm package, or downloaded
executable. Cargo, the Node runtime supplied by GitHub Actions, and access to the crates.io index
are required. crates.io is an unavoidable data source: a lockfile does not contain publication
timestamps.
