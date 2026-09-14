# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access, then
install Socket Firewall Enterprise with a short-lived Socket token. Use this
action as the first step in a job. The nested remote actions retain their pre-job
initialization and post-job cleanup, including token revocation.

Before subsequent **Bash** steps, a `BASH_ENV` hook discovers available package
managers, activates their Socket wrappers, and puts the wrappers first on `PATH`.
Standard setup actions can install tools or change versions after `secure-runner`;
the next Bash step repairs interception automatically. Commands remain ordinary
`cargo install`, `npm install`, or `pnpm install`, without an `sfw` prefix.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `dev`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`.

`dev` also selects the Socket STS endpoint. Both services use production by
default; set `dev: true` to use their development endpoints.

The caller must grant `id-token: write` for both STS exchanges. Harden Runner
policies must allow the network access needed to install and use Socket Firewall.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On a `pull_request` run without an OIDC token,
Harden Runner emits a warning annotation and runs with the inline policy from the
`egress-policy`, `allowed-endpoints`, and `denied-endpoints` inputs instead of the
StepSecurity policy store, and Socket Firewall installs its Free edition instead of
Enterprise, since the Enterprise token is minted from the job's OIDC identity. Any
other event without an OIDC token fails, since that means the job is missing
`id-token: write`.

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

# Required on Windows, whose default shell is PowerShell. Also avoids falling
# back to sh in other environments; Bash must be installed on the runner.
defaults:
  run:
    shell: bash

steps:
  - name: Secure runner
    uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>

  - uses: actions/checkout@<commit-sha>

  - uses: actions/setup-node@<commit-sha>
    with:
      node-version: "24"

  # npm is discovered after setup-node; pnpm is discovered on the next step.
  - run: npm install --global pnpm@11.9.0
  - run: pnpm install --frozen-lockfile
```

## Bash interception contract

The hook runs before each non-interactive Bash process that honors `BASH_ENV`,
including Git for Windows Bash. Node must be available on `PATH` when the action
installs the hook (as it is on GitHub-hosted runners). The launcher pins that
Node executable and Bash for its output guard; both must remain available.
Later setup actions changing the selected Node version do not change the guard.

- Only managers actually present are activated, so a missing manager does not
  look installed to setup tools. A manager installed during a step is discovered
  at the next Bash startup.
- The launcher resolves the real executable at invocation time, excluding both
  the refreshed and original Socket shim directories. Version switches do not
  retain a stale executable path.
- Startup fails if the Socket executable is missing, the hook cannot activate,
  or a shell alias/function shadows an activated wrapper. The action verifies
  startup in a separate Bash step before returning success.
- Already wrapped processes inherit Socket's proxy environment. Their nested
  Bash shells do not wrap package managers a second time. Independent Bash
  processes still activate interception.
- Existing `BASH_ENV` files are sourced first and must be readable absolute,
  literal paths. Commands in those files execute before shim refresh. Dynamic
  shell expressions in `BASH_ENV` are not supported. Shell options, traps, and
  arguments are not changed by this hook.
- `_TEMPO_SFW_ACTIVE` and `_TEMPO_SFW_STARTING` are internal process-scoped
  recursion guards. Do not set them in workflows.

The supported command list matches the pinned Socket installer: `cargo`, `npm`,
`pip`, `pip3`, `pnpm`, `uv`, and `yarn` in Free and Enterprise; Enterprise also
includes `bundler`, `gem`, and `nuget`, plus `go` on Linux. This does not add new
ecosystem support to Socket. The existing upstream shims and `SFW_SHIM_DIR` are
retained; the refreshed Bash shims live alongside the hook under `RUNNER_TEMP`.

## Compatibility and limits

The Cargo launcher defaults `CARGO_NET_GIT_FETCH_WITH_CLI` to `true` so Git uses
Socket's certificate environment. An explicit caller value is preserved, and
the default only applies inside the wrapped Cargo process tree.

This change does **not** set `SFW_UNKNOWN_HOST_ACTION`, custom registry rules,
`NODE_OPTIONS`, or disable TLS/revocation checks. Keep necessary compatibility
settings and narrowly scoped endpoint exceptions explicit in the calling job.
Start sccache outside a wrapped Cargo process when it needs its own proxy
environment. Nonzero Socket/command exit codes are preserved. As a temporary
mitigation for [SocketDev/sfw-free#61](https://github.com/SocketDev/sfw-free/issues/61),
every refreshed launcher also fails if either output stream contains
`Socket Firewall encountered an unexpected error`, even when Socket exits zero.
Output is streamed without merging stdout and stderr; the scan handles split
writes and does not store whole logs. No offline fetch or report upload is added.
This detects the known error signature, not silent validation failures or cache
completeness. A generated Socket report alone is not proof of validation.

This is command routing for cooperating Bash workflows, not a runner-wide
security boundary:

- JavaScript actions, PowerShell, `sh`, separate containers, and actions that
  clear `BASH_ENV` do not execute the hook. Setting `defaults.run.shell: bash`
  does not override shells selected inside other actions. In particular, the
  pinned `taiki-e/install-action` clears `BASH_ENV`.
- Later changes to `PATH`, aliases, functions, or `BASH_ENV` inside a running
  script can invalidate interception; absolute executable paths also do not
  resolve through the shims.
- Toolchain installers and direct release-binary downloads are not package
  scans. Continue to verify their checksums/provenance separately.
- Restored package caches are not downloaded again and are not rechecked by
  Socket's network interception. Each job/reusable workflow needs its own setup.
- Existing fork-PR Free fallback and organization-policy differences are
  unchanged.

## Validation

Run `node --test actions/secure-runner/bash-hook.test.js` for the local process
tests. They exercise late installation, version changes, prior startup files,
nested/concurrent shells, argument preservation, failure propagation, and the
internal-error guard across supported managers. They also check split writes,
separate output streams, stdin, and cancellation on POSIX. Error and policy-denial
fixtures use a **fake Socket executable**, not a live organization policy check
or a reproduced upstream outage, and never download a malicious package.

`Test / Socket Bash interception` runs those tests on Linux, macOS, and Windows
and then exercises the checkout's installer with real Socket, upstream Node/Rust
setup, npm-installed pnpm, and a fresh benign dependency download. The existing
released action bootstraps credentials before checkout; the test installs this
checkout's hook separately to avoid starting Harden Runner twice.
