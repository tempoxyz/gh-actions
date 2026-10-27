# Codex repair

Bounded Rust dependency repair on the runner, with independent checks after every Codex invocation.
The Python standard-library implementation is also used by
[`dependency-update.yml`](../../.github/workflows/dependency-update.yml).

Use the [shared workflow](../dependency-update/README.md) to prepare an update,
publish a PR, and repair its CI failures. This standalone action only repairs a
prepared source export; it does not fetch GitHub tokens, commit, push, or merge.

## Runner execution

Requires an ephemeral Linux runner with Python 3.11+, Rust/rustfmt/Clippy, Codex,
cargo-nextest and the repository's native build dependencies already on PATH.
The [shared workflow](../dependency-update/README.md) installs these tools from
versioned inputs. The standalone action uses tools the caller installed.
No Docker daemon, worker image, registry or image publication is involved.

Each command runs directly as a runner process in an exported source directory
without `.git`. Child environments are built from an allowlist and omit GitHub,
OIDC and registry credentials and Actions output paths. Only Codex gets
`CODEX_API_KEY`. Rustup uses the installed runner toolchains. Lockfile resolution
runs in a temporary source copy and imports only Cargo.lock.

After resolving the lockfile, `cargo fetch --locked` runs through the runner's
package firewall (including Aegis when enabled). Verification uses offline Cargo
with a copy of those downloads, fresh HOME/configuration and no agent cache.
Verification commands share a separate build target only within one check pass
on an unchanged candidate; it is deleted before repairs and on success/failure.
Artifacts from different toolchains, build modes and feature sets can coexist
until that pass ends, so peak disk use can exceed the largest individual check.
Select a runner with enough free storage for the combined verification artifacts
through the shared workflow's `runner` input.
Agent invocations may reuse their own cache. Codex state stays in a
separate `CODEX_HOME` outside the candidate; runs are ephemeral and ignore user config.
`codex exec` skips the Git repository check for the exported source and runs
non-interactively with full runner access, matching the existing runner model.
The API key is excluded from Codex shell-tool environments; this does not
prevent the agent from reading it through other means. Checks compare source
snapshots before and after every command, so a check that changes source fails.

A failed or timed-out run prints only progress lines and a withheld-details
notice, never exception payloads or command output. When the failure is one of
the coordinator's own fixed reasons (such as `local repair attempts exhausted`
or `change outside repair scope`), that reason is also published as an
`::error::` annotation, so it shows on the run summary and in the checks API.
Paths and other formatted details are dropped, since file names can be chosen by
the agent; any other failure is annotated only as failed or timed out.
These checks detect changes; the source is not mounted read-only. Commands use
new process groups, which are killed on completion, timeout and cancellation.
Each command is limited to 45 minutes and the remaining total repair budget.

Progress logs contain only fixed phase names, numeric check/attempt counters,
elapsed seconds and exit codes, with a heartbeat every 30 seconds while a worker
command runs. Child output remains private to the repair loop: command arguments,
prompts, Codex events/thread IDs, environments, paths and exception details are
not printed. Entrypoint failures report a generic failure/timeout without a
traceback. Raw logs are not uploaded as artifacts, including on timeout; the
phase/timing messages remain available in Actions. This limits diagnosis to
phase/status metadata rather than relying on credential redaction or masking.

**This is not a security sandbox.** Codex and dependency build scripts run as the
same OS user as the coordinator. Environment filtering, fresh state and process
group cleanup do not prevent access to runner files, other processes, credentials,
network, tool installations or same-user modifications. Use disposable runners
without unrelated secrets or shared trusted caches. A process can deliberately
escape its process group; this runner mode does not contain hostile code. STS
publishing credentials are minted only after repair/check processes return and
revoked before further repairs, but this is not credential isolation from code
sharing the runner. Private source and diagnostics may be sent to Codex, whose key
is necessarily available to the agent. Review migrations before merging.

This action uses the CLI directly. OpenAI recommends its
[GitHub Action/proxy](https://developers.openai.com/codex/github-action) for
stronger API-key protection; integrating that protection into the coordinator
requires a separate execution design. Store a standard OpenAI API key as
`CODEX_API_KEY`; do not supply a ChatGPT login token.

## Inputs and outputs

Required inputs: `source`, `baseline` (absolute paths to source exports without
`.git`), `pins` (JSON map of selected GitHub HTTPS source URL to full commit SHA;
manifests may spell `rev` as that SHA or an abbreviation of it, such as the
spelling an upstream dependency uses, while `Cargo.lock` must resolve the full SHA),
`local-checks`, `allowed-paths`, and `codex-api-key`.
Optional inputs: `repair-instructions`, `max-repairs` (3), `budget-minutes` (60),
`codex-model` and `codex-effort` (empty uses CLI/model defaults).

Check commands are newline-separated argument lists parsed with `shlex`, not
shell programs. Pipelines, substitutions, and environment assignments are not
supported. Checks must leave source unchanged and use a prepared lockfile; use
`--locked` for Cargo builds/tests. Source-changing fixes belong to the repair phase.
Use an installed helper command for more complex checks.

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
the prepared source directory for inspection. One Codex/check invocation has a
maximum 45-minute timeout, also bounded by the remaining total budget. Codex exit
errors are reported; passing the actual checks determines success. Codex thread
IDs are logged for diagnostics; they are not hosted transcript links.
