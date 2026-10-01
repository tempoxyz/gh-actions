# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access and
install Aegis with a short-lived Socket token concurrently. Use this action as
the first step in a job.

Secure Runner is a single `node24` action. Its main entrypoint runs StepSecurity's
OIDC/STS exchange and installation in a child process alongside Aegis's
OIDC/STS exchange, verified download, and installation. Separate processes let
the existing synchronous installers overlap. It waits for both setup paths to
finish, including on failure, before returning; checkout and later job steps
therefore cannot race setup. Aegis bootstrap may run before StepSecurity monitoring
is active. Its post-job entrypoint overlaps independent reporting and cleanup.
It runs
the same code the standalone [Harden Runner](../harden-runner), [Aegis](../aegis),
[Step Security STS](../step-security-sts), [Socket STS](../socket-sts),
[Aegis Report](../aegis-report) actions run,
loaded as modules from the same pinned revision, so one `secure-runner@<sha>`
pin selects every piece and there are no nested pins to refresh.

No Node installation is required before or inside this action: it runs on the
runner's bundled Node. Each STS still receives an assertion issued for its own
audience. StepSecurity obtains its assertion in the child process; Aegis's OIDC
client warms the Socket STS and release-server assertions concurrently.

Release preparation fetches the binary, checksums, and provenance concurrently.
It also fetches fresh Sigstore trusted roots through `gh attestation trusted-root`
alongside release lookup and downloads, then passes those roots to verification
with `--custom-trusted-root`. Roots are not cached across jobs; checksum and
provenance constraints still apply before installation. All started transfers
and the root-fetch subprocess finish before setup returns, even on failure.

Aegis setup exchanges a Socket API token concurrently with its release preparation.
The release branch bootstraps a GitHub CLI with attestation support on Linux if
needed, downloads Aegis through `aegis.tempoxyz.net` for the runner operating
system and architecture, verifies it against `SHA256SUMS` and its Sigstore
provenance (signer workflow, release-tag source commit, and `refs/heads/main`),
then waits for Socket authentication to finish. CLI bootstrap and provenance
verification use asynchronous subprocesses so authentication can progress during
both. Once both branches succeed, setup seeds the loopback token provider with
the cached Aegis OIDC assertion through private IPC, refreshing it with setup's
bounded retries if needed. The first package scan can therefore use an existing
identity immediately. Setup then prepares the Aegis lifecycle and installs
the package. Aegis is never installed without a Socket API token, and only a
verified release is ever installed. See [Aegis](../aegis) for policy behavior
and supported runners.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `step-security-sts-host`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`. `socket-sts-host`
selects the Socket STS. `aegis-version` selects an exact published release tag,
including stable tags such as `v0.15.0` and prerelease tags such as
`20260927T194115Z-5e7bd8b807b2`. When empty, the action selects the latest
stable release from the Aegis server. Downloads require `id-token: write` and
do not require access to the private `tempoxyz/aegis` repository.

`disable-enforcement: true` skips both Harden Runner and Aegis with a warning
annotation. It is intended for Aegis's own installation tests, where a
preinstalled Aegis service would conflict with the version under test and a large
test matrix would otherwise request a separate StepSecurity credential per job.

Every warning below that skips or degrades protection is also written to the
job's step summary, so a job that ran with reduced enforcement says so on its
summary page and not only in its annotations.

Both services use production by default. For a development deployment, set
`step-security-sts-host: ss-sts.tempoxyz.dev` and/or
`socket-sts-host: socket-sts.tempoxyz.dev`.

The caller must grant `id-token: write` for the STS exchanges. Harden Runner
policies must allow the network access needed to install and use Aegis.

The action has no outputs. The Aegis binary and audit log live at fixed
per-platform paths, and the audit log is uploaded as a job artifact at job end.

## Degraded runs

Harden Runner does not support Windows ARM64. On that runner, this action emits a
warning annotation, skips Harden Runner, and continues to install Aegis.

If Harden Runner's own pre-job entrypoint fails, for example because its agent
cannot be downloaded or the runner lacks a prerequisite, the action emits a warning
annotation titled "Harden Runner unavailable" and the job continues without Harden
Runner's monitoring. The Step Security lease is still revoked at job end, and
Harden Runner's post-job cleanup runs best-effort. Harden Runner itself reports
download and checksum failures as error annotations while exiting zero, so those
already continue without the agent; this covers a crash or a future change.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On a `pull_request` run without an OIDC token,
Harden Runner emits a warning annotation and runs with the inline policy from the
`egress-policy`, `allowed-endpoints`, and `denied-endpoints` inputs instead of the
StepSecurity policy store. Aegis setup emits a warning and installs nothing, so
package downloads are not inspected or blocked. Any other event without an OIDC
token fails, since that means the job is missing `id-token: write`.

When GitHub does issue an OIDC token but no StepSecurity policy-store
credential can be obtained, Harden Runner degrades instead of failing the job.
That covers connection failures and timeouts, transient responses (HTTP 408,
425, 429, and 5xx) that persist through every retry, an exhausted rate-limit
wait budget, malformed responses, and definitive rejections such as HTTP 401 or
403, whether from the Step Security STS or from GitHub's OIDC issuer. Each
exchange has a 90-second budget covering requests, retries, and rate-limit
waits, so a degraded job loses at most that long per credential. The action
emits a warning annotation titled "StepSecurity policy store unavailable" that
names the failure, then starts Harden Runner without the policy store, so the
inline `egress-policy` applies: audit mode by default, which observes and reports
egress without blocking it. This matches Harden Runner's own behavior, which
defaults to audit mode whenever it has no policy-store credential or finds no
stored policy. Only an invalid `step-security-sts-host` or `socket-sts-host`
input still fails the job, since both are validated before any request is made.

Before each exchange, the action asks the STS whether it is serving exchanges
with one empty `POST /status`. An STS an operator has paused answers
`{"status":"disabled","reason":"Paused"}`, and the action degrades at once
instead of retrying against its rejections for the rest of the budget. The
warning annotation is then titled "Step Security STS disabled", "Socket STS
disabled", or "GitHub STS disabled" and carries the reason the service gave, so
a deliberate pause reads differently from an outage. Any other answer to the
probe, including none at all, is inconclusive: the exchange proceeds and
reports its own failures as above.

Aegis setup degrades the same way. Socket authentication and CLI bootstrap plus
download/verification run concurrently; if either fails after its own retries,
the action waits for the other branch to finish and records any issued token
for cleanup. It does not start the token provider, lifecycle handler, or package
installation unless both branches succeed. Those later stages run in order and
stop at the first failure. The action then emits a warning annotation titled
"Package-policy enforcement disabled" naming the stage that failed and the
error, and the job continues without a package firewall: package downloads are
not inspected or blocked. A checksum or provenance mismatch is reported the
same way and installs nothing.

Credential cleanup at job end is best-effort in the same spirit. The Aegis audit
log is copied before teardown and uploaded concurrently with cleanup. When
`RUNNER_ENVIRONMENT` is exactly `github-hosted`, Aegis teardown is skipped: GitHub
discards the runner after the job. Other Linux runners retain identity-checked
uninstall in a child process, so the upload can progress during teardown.
Once teardown completes (or is skipped), Socket token revocation and Harden
Runner's telemetry flush run concurrently, without waiting for the audit upload.
The Step Security lease is revoked only after its telemetry flush finishes.
On GitHub-hosted runners, StepSecurity's post event and completion acknowledgement
are retained, but process teardown and diagnostic log harvesting are skipped;
GitHub discards the VM. The vendored post hook still renders the security summary.
Self-hosted and unknown runner environments retain the full vendored cleanup.
All started operations are awaited even on failure; no cleanup is detached.
If an STS cannot revoke its lease or token after
retries, the post-job step reports a warning rather than failing a job that has
already finished; every lease and token expires on its own. Corrupt saved state
still fails, since that indicates a bug rather than an outage. On self-hosted
Linux runners a failed Aegis cleanup still fails the job, because a leftover
managed installation would affect the next job there.

## Node certificate trust

After Aegis installs successfully, Secure Runner exports `NODE_EXTRA_CA_CERTS`
through `GITHUB_ENV` for later steps. On Linux it points to
`/etc/aegis/bundle.pem`; macOS and Windows use their installed Aegis bundle.
If the job already sets `NODE_EXTRA_CA_CERTS`, Secure Runner creates a private
combined bundle under `RUNNER_TEMP` containing both the existing certificates
and Aegis's certificates.

This covers Node fetch clients such as pnpm 11's trusted-publishing OIDC token
exchange, which does not apply `.npmrc`'s `cafile` setting. TLS verification and
Aegis package policy remain enabled; registry writes already pass through
without package scanning. Disabled or unsuccessful installations do not change
Node trust. A failure to export trust after installation fails setup rather
than leaving later Node requests unable to authenticate Aegis's certificates.

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Secure runner
    uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha>
    # For Aegis's own installation tests only:
    # with:
    #   disable-enforcement: true

  - uses: actions/checkout@<commit-sha>

  # Supported package-manager commands now run through Aegis.
  - run: pnpm install --frozen-lockfile
```
