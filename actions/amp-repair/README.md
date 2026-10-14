# Amp repair

Bounded Rust dependency repair with independent checks after every Amp invocation.
The Python standard-library implementation is also used by
[`dependency-update.yml`](../../.github/workflows/dependency-update.yml).

Use the [shared workflow](../dependency-update/README.md) to prepare an update,
publish a PR, and repair its CI failures. This standalone action only repairs a
prepared source export; it does not fetch GitHub tokens, commit, push, or merge.

## Worker boundary

Requires Python 3.11+, a Linux Docker runner with `cargo` on `PATH` (preinstalled
on GitHub-hosted Ubuntu), and a caller-approved image pinned by `@sha256:<digest>`. The image contains Amp, Rust/rustfmt/Clippy, cargo-nextest,
and any native build dependencies. Tools must work as the runner UID with a
read-only root filesystem; mutable Cargo/Amp state goes under `/cache`. Install
tools in `/usr/local/cargo/bin`, `/usr/local/bin`, `/usr/bin` or `/bin`; worker
PATH contains only those image directories, and Rust toolchains must be available
read-only in `/usr/local/rustup`. Build
and verify that image through the caller's existing image pipeline; this action
does not execute a mutable installer on the privileged runner.

Each command gets a fresh container with only the exported source and an
expendable worker cache mounted.

Dependency downloads for checks happen on the runner: after each lockfile
resolution, the coordinator runs `cargo fetch --locked` (no build scripts) with a
scrubbed environment into a runner-owned Cargo home. Host-only package firewalls
such as Aegis therefore inspect every crate the candidate locks, which they could
not do for container traffic. Check containers run with `--network none`, offline
Cargo, and that Cargo home mounted read-only; the action first confirms the
image's Cargo can use it offline. Lockfile resolution and the agent still have
network access; the agent's own Cargo runs inside its sandbox, and whatever it
locks is fetched through the runner before any check or publication. Verification mounts source read-only and checks
its snapshot before and after every command; all checks must verify the same
unchanged candidate. Only Amp may edit the candidate. The coordinator resolves
Cargo.lock separately in a disposable writable copy and imports only that lockfile.
Every verification command gets a new empty
cache, including HOME, Cargo downloads/configuration and target output; it never
reuses agent state or an earlier check's build output. This prevents cache-written
tools/configuration from replacing later checks, at the cost of fresh downloads
and compilation for each command. Agent invocations can reuse their own cache.
No `.git`, host HOME, runner temp directory,
Docker socket, host PID namespace, or GitHub/OIDC credentials are mounted or
forwarded. Containers have no capabilities, cannot gain privileges, and have
memory/PID limits. `/tmp` is a 1 GiB tmpfs mounted with `exec`, because the Amp
CLI loads native modules from it; workers already execute build output from
their cache, so `noexec` would add no protection. Amp alone receives `AMP_API_KEY`; check workers do not receive
it in their environment. Cache state is worker-owned and is never restored into
trusted CI caches. This is process/container isolation, not a separate VM.

Worker removal is mandatory on success, failure, cancellation, and timeout. If
cleanup cannot be confirmed, the action fails rather than continuing. The Amp
key necessarily belongs to the agent's trust boundary; private source and
diagnostics can be sent to Amp. The action does not promise to establish the
semantic correctness of an invariant migration.

## Inputs and outputs

Required inputs: `source`, `baseline` (absolute paths to source exports without
`.git`), `pins` (JSON map of selected GitHub HTTPS source URL to full commit SHA),
`worker-image`, `local-checks`, `allowed-paths`, and `amp-api-key`.
Optional inputs: `repair-instructions`, `max-repairs` (3), `budget-minutes` (60).

Check commands are newline-separated argument lists parsed with `shlex`, not
shell programs. Pipelines, substitutions, and environment assignments are not
supported. Checks must work with read-only source and a prepared lockfile; use
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
