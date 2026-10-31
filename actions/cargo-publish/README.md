# cargo publish (trusted publishing)

Publish a Cargo workspace's crates to crates.io from CI with
[trusted publishing](https://crates.io/docs/trusted-publishing): the job exchanges its GitHub
OIDC token for a crates.io token that lasts 30 minutes and is revoked when the job ends, so no
`CARGO_REGISTRY_TOKEN` secret exists to leak.

1. **Plan:** reads `cargo metadata`, keeps the workspace members that may be published to
   crates.io (or the `packages` you name), and orders them so each comes after the workspace
   crates it depends on. With `skip-published` (the default), a crate whose version is already in
   the crates.io index is skipped, so re-running a release that stopped halfway resumes it.
2. **Authenticate:** [`rust-lang/crates-io-auth-action`](../../vendor/rust-lang/crates-io-auth-action),
   vendored and pinned. Skipped for dry runs and when nothing is left to publish.
3. **Publish:** `cargo publish -p <crate>` one crate at a time. When crates.io answers 429, it
   waits until the time crates.io gives (or backs off exponentially) and retries, up to
   `rate-limit-retries` times. A version that is already uploaded counts as done. A dry run
   runs one `cargo publish --dry-run -p … -p …` for the whole plan, so cargo checks every crate
   against the others' unpublished versions.

The plan orders a crate after a workspace crate it dev-depends on with a `version`, because
cargo keeps such dev-dependencies in the uploaded manifest and crates.io rejects them until that
crate exists; the edge is dropped only when it would form a cycle.

The token lasts 30 minutes. The action never starts an upload, delay or rate-limit wait past its
first 25 minutes; it stops with the list of what it published, and rerunning the job (with
`skip-published`) gets a fresh token and continues from there.

Requires Node.js and Rust 1.90 or newer (`cargo publish` with several `-p`, used by dry runs)
on the runner. GitHub-hosted and Depot runners have Node.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `packages` | Crates to publish (space, comma or newline separated). Empty publishes every member that may be published to crates.io | `""` |
| `exclude` | Crates to leave out | `""` |
| `working-directory` | Directory of the Cargo workspace | `.` |
| `dry-run` | Only `cargo publish --dry-run`; no token is requested | `false` |
| `skip-published` | Skip crates whose version is already on crates.io | `true` |
| `locked` | Pass `--locked` | `true` |
| `delay-seconds` | Pause between crates | `0` |
| `rate-limit-retries` | Retries per crate after a 429 | `10` |

## Outputs

`packages` (planned, in order), `skipped` (already on crates.io) and `published` (uploaded by
this run), each space separated.

## Usage

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions: {}

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release # optional; require reviewers on it for a human approval step
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Secure runner
        uses: tempoxyz/gh-actions/actions/secure-runner@<sha> # <tag>
      - uses: actions/checkout@<sha> # <tag>
        with:
          persist-credentials: false
      - uses: tempoxyz/gh-actions/vendor/dtolnay/rust-toolchain@<sha> # <tag>
      - uses: tempoxyz/gh-actions/actions/cargo-publish@<sha> # <tag>
```

Run it with `dry-run: true` on pull requests to catch packaging errors before a release.

## Setting up crates.io

For each crate, an owner opens `https://crates.io/crates/<crate>/settings` and adds a GitHub
trusted publisher:

- **Repository owner / name:** the repository that runs the workflow, such as `alloy-rs` / `alloy`.
- **Workflow filename:** the calling workflow's file name, such as `release.yml`. This is a
  composite action, so crates.io sees the caller's workflow, not this repository.
- **Environment:** the job's `environment`, if it has one. Set it whenever the job uses one, so
  only that environment's protection rules can unlock a publish.

A crate must already exist on crates.io before it can have a trusted publisher, so publish a
brand-new crate once by hand. Once a CI release has worked, turn on **Require trusted publishing
for all new versions** in the same settings page, so API tokens can no longer publish the crate.
