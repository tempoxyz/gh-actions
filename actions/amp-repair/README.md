# Amp repair

Bounded Rust dependency repair on the runner, with independent checks after every Amp invocation.
The Python standard-library implementation is also used by
[`dependency-update.yml`](../../.github/workflows/dependency-update.yml).

Use the [shared workflow](../dependency-update/README.md) to prepare an update,
publish a PR, and repair its CI failures. This standalone action only repairs a
prepared source export; it does not fetch GitHub tokens, commit, push, or merge.

## Runner execution

Requires an ephemeral Linux runner with Python 3.11+, Rust/rustfmt/Clippy, Amp,
cargo-nextest and the repository's native build dependencies already on PATH.
The [shared workflow](../dependency-update/README.md) installs these tools from
versioned inputs. The standalone action uses tools the caller installed.
No Docker daemon, worker image, registry or image publication is involved.

Each command runs directly as a runner process in an exported source directory
without `.git`. Child environments are built from an allowlist and omit GitHub,
OIDC and registry credentials and Actions output paths. Only Amp gets
`AMP_API_KEY`. Rustup uses the installed runner toolchains. Lockfile resolution
runs in a temporary source copy and imports only Cargo.lock.

After resolving the lockfile, `cargo fetch --locked` runs through the runner's
package firewall (including Aegis when enabled). Verification uses offline Cargo
with a copy of those downloads, fresh HOME/configuration/build output and no
agent cache. Agent invocations may reuse their own cache. Checks compare source
snapshots before and after every command, so a check that changes source fails.
These checks detect changes; the source is not mounted read-only. Commands use
new process groups, which are killed on completion, timeout and cancellation.
Each command is limited to 45 minutes and the remaining total repair budget.

**This is not a security sandbox.** Amp and dependency build scripts run as the
same OS user as the coordinator. Environment filtering, fresh state and process
group cleanup do not prevent access to runner files, other processes, credentials,
network, tool installations or same-user modifications. Use disposable runners
without unrelated secrets or shared trusted caches. A process can deliberately
escape its process group; this runner mode does not contain hostile code. STS
publishing credentials are minted only after repair/check processes return and
revoked before further repairs, but this is not credential isolation from code
sharing the runner. Private source and diagnostics may be sent to Amp, whose key
is necessarily available to the agent. Review migrations before merging.

## Inputs and outputs

Required inputs: `source`, `baseline` (absolute paths to source exports without
`.git`), `pins` (JSON map of selected GitHub HTTPS source URL to full commit SHA),
`local-checks`, `allowed-paths`, and `amp-api-key`.
Optional inputs: `repair-instructions`, `max-repairs` (3), `budget-minutes` (60).

Check commands are newline-separated argument lists parsed with `shlex`, not
shell programs. Pipelines, substitutions, and environment assignments are not
supported. Checks must leave source unchanged and use a prepared lockfile; use
`--locked` for Cargo builds/tests. Source-changing fixes belong to the repair phase.
Use an image-provided command for more complex checks.

`allowed-paths` uses `*` within one directory and `**` across directories. Only
Rust files, `Cargo.toml`, and `Cargo.lock` may change. `.git`, `.github`, `.cargo`,
and `scripts` are always denied. New symlinks, special files, and file-mode
changes are unsupported. Tracked gitlinks and symlinks are frozen: they are not
exported (matching a checkout without submodules), changes at or inside those
paths are denied, and the published tree must keep them unchanged.
New `build.rs` files, path dependencies outside the repository, and changes to
`[patch]`, `[replace]`, `[profile]`, `[lints]`, `[workspace.lints]`, workspace
members/excludes, or `package.build` are rejected. Validation includes ignored/untracked files, dependency
identity changes (including URL aliases/removal), Cargo patch/replace changes,
and resolved lockfile commits. Git exports read the complete tree and raw blobs;
archive attributes cannot omit paths or substitute content. It rejects raw runner credentials in candidate
changes; callers must still review source before merging.

Outputs are `status` and `repair-attempts`. Exhaustion fails the action and leaves
the prepared source directory for inspection. One Amp/check invocation has a
maximum 45-minute timeout, also bounded by the remaining total budget. Amp exit
errors are reported; passing the actual checks determines success.
