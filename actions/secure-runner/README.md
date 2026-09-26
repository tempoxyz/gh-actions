# Secure Runner

Start Harden Runner with authenticated StepSecurity policy-store access, then
install Aegis with a short-lived Socket token. Use this action as the first step
in a job.

Secure Runner is a single `node24` action. Its pre-job entrypoint starts Harden
Runner before checkout, its main entrypoint installs Aegis, and its post-job
entrypoint cleans both up. It runs the same code the standalone
[Harden Runner](../harden-runner), [Aegis](../aegis),
[Step Security STS](../step-security-sts), [Socket STS](../socket-sts),
[GitHub STS](../github-sts), and [Aegis Report](../aegis-report) actions run,
loaded as modules from the same pinned revision, so one `secure-runner@<sha>`
pin selects every piece and there are no nested pins to refresh.

No Node installation is required before or inside this action: it runs on the
runner's bundled Node. One GitHub OIDC client serves every credential exchange.
Each STS still receives an assertion issued for its own audience, and the
assertions are requested concurrently, so the job pays roughly one request of
latency for three credentials.

Harden Runner starts first. Aegis setup then exchanges a Socket API token,
exchanges a GitHub App token under the `download-releases` policy in
`tempoxyz/aegis`, bootstraps a GitHub CLI with attestation support on Linux if
needed, downloads the latest stable Aegis release for the runner operating
system and architecture, verifies it against `SHA256SUMS` and its Sigstore
provenance (signer workflow, release-tag source commit, and `refs/heads/main`),
starts the loopback token provider, prepares the Aegis lifecycle, and installs
the package. Aegis is never installed without a Socket API token, and only a
verified release is ever installed. See [Aegis](../aegis) for policy behavior
and supported runners.

## Inputs

Accepts all inputs and defaults from [Harden Runner](../harden-runner/action.yml)
and forwards them unchanged: `step-security-sts-host`, `egress-policy`, `allowed-endpoints`,
`denied-endpoints`, `disable-telemetry`, `disable-sudo-and-containers`,
`disable-file-monitoring`, `deploy-on-self-hosted-vm`, and `token`. `socket-sts-host`
selects the Socket STS.

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

Aegis setup degrades the same way. Its stages run in order, and if one fails
after its own retries, nothing after it runs: the Socket STS exchange, the
GitHub STS exchange for the release token, the GitHub CLI bootstrap, the Aegis
download and verification, the token provider, the lifecycle handler, and the
package installation. The action then emits a warning annotation titled
"Package-policy enforcement disabled" naming the stage that failed and the
error, and the job continues without a package firewall: package downloads are
not inspected or blocked. A checksum or provenance mismatch is reported the
same way and installs nothing.

Credential cleanup at job end is best-effort in the same spirit. The Aegis audit
log uploads and the Linux installation retires before the Socket token that fed
it is revoked; the GitHub App token and the Step Security lease are revoked, and
Harden Runner stops last. If an STS cannot revoke its lease or token after
retries, the post-job step reports a warning rather than failing a job that has
already finished; every lease and token expires on its own. Corrupt saved state
still fails, since that indicates a bug rather than an outage. On self-hosted
Linux runners a failed Aegis cleanup still fails the job, because a leftover
managed installation would affect the next job there.

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
