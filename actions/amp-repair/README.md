# Amp repair

Bounded Rust dependency repair with independent checks after every Amp invocation.
The Python standard-library implementation is also used by
[`dependency-update.yml`](../../.github/workflows/dependency-update.yml).

Use the [shared workflow](../dependency-update/README.md) to prepare an update,
publish a PR, and repair its CI failures. This standalone action only repairs a
prepared source export; it does not fetch GitHub tokens, commit, push, or merge.

## Worker boundary

Requires Python 3.11+, a Linux Docker runner, and a caller-approved image pinned
by `@sha256:<digest>`. The image contains Amp, Rust/rustfmt/Clippy, cargo-nextest,
and any native build dependencies. Tools must work as the runner UID with a
read-only root filesystem; mutable Cargo/Amp state goes under `/cache`. Build
and verify that image through the caller's existing image pipeline; this action
does not execute a mutable installer on the privileged runner.

Each command gets a fresh container with only the exported source and an
expendable worker cache mounted. No `.git`, host HOME, runner temp directory,
Docker socket, host PID namespace, or GitHub/OIDC credentials are mounted or
forwarded. Containers have no capabilities, cannot gain privileges, and have
memory/PID limits. Amp alone receives `AMP_API_KEY`; check workers do not receive
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
supported. Use an image-provided command for more complex checks.

`allowed-paths` uses `*` within one directory and `**` across directories. Only
Rust files, `Cargo.toml`, and `Cargo.lock` may change. `.git`, `.github`, `.cargo`,
and `scripts` are always denied. Symlinks, gitlinks, special files, and file-mode
changes are unsupported. Validation includes ignored/untracked files, dependency
identity changes (including URL aliases/removal), Cargo patch/replace changes,
and resolved lockfile commits. It rejects raw runner credentials in candidate
changes; callers must still review source before merging.

Outputs are `status` and `repair-attempts`. Exhaustion fails the action and leaves
the prepared source directory for inspection. One Amp/check invocation has a
maximum 20-minute timeout, also bounded by the remaining total budget. Amp exit
errors are reported; passing the actual checks determines success.
