# Socket Firewall

Install Aegis with a short-lived Socket API token derived from the calling
job's GitHub OIDC identity. The Socket STS associates the token with the
caller's repository and records its workflow, run, attempt, and initiating
GitHub actor.

The download and token-provider scripts reuse the Node executable already
provided by the GitHub Actions runner, obtained from Socket STS's `node-path`
output. They do not need `node` on `PATH` or a preceding `actions/setup-node`
step. When used through Secure Runner, Harden Runner starts before any of this
setup. If the GitHub CLI is missing or lacks attestation support on Linux, the
action bootstraps the checksum-pinned, provenance-verified CLI before downloading
Aegis; this happens inside Secure Runner, after Harden Runner starts.

The action uses GitHub STS policy `download-releases` in `tempoxyz/aegis` to
download the native artifact for the runner operating system and architecture
from GitHub's latest stable Aegis release. GitHub's `releases/latest` API excludes
draft and prerelease releases. Before installation, the action verifies the
artifact against `SHA256SUMS` and the release's Sigstore provenance bundle,
including the signer workflow, release-tag source commit, and `refs/heads/main`
source ref. Releases built from pull-request or feature-branch refs are rejected.
Each release download attempt is bounded to two minutes and each provenance
verification to one minute; a stalled transfer is killed and retried rather than
holding the job. Retries back off exponentially with up to 25% jitter.

Supported runners are Linux, Windows, and macOS on X64 or ARM64. Aegis v0.4.0
restores Intel macOS artifacts; macOS X64 runners use the `macos-amd64.tar.gz`
CLI package with the same checksum and provenance verification as other targets.

This release honors effective Socket `pendingScan` actions of `ignore` or
`monitor`, including `alertPriorities` overrides, without requiring complete
analysis. Other alerts and records are still validated, so policy blocks still
win. Other pending actions retain bounded polling until the 90-second lookup
deadline (or an earlier caller deadline), then fail closed by default. Pending
backoff is 2, 4, 8, then 10 seconds, plus up to 25% jitter. HTTP 429 responses
also retry within that deadline, honoring a valid `Retry-After` delay or HTTP
date and otherwise using the same backoff schedule. Transient network/read
errors and HTTP 502/503/504 retain a separate two-retry budget.

HTTP/1.x block responses now expose the reason and request ID in the status text
that pnpm displays. Lookup failures are classified separately from policy
denials. Per-attempt Socket diagnostics are written to the Aegis service log.
Before Aegis is installed, the action registers a dedicated post-job handler to
upload the final log as a seven-day `aegis-service-log-<job>-aegis-report`
artifact. Upload failures are warnings and do not hide the original job result.

On dedicated Linux runners, the handler first uninstalls any previous managed
installation with its incumbent binary. A new installation uses this job's token
provider. At job shutdown, logs upload before the owned installation is removed,
and Socket STS then revokes the token. Cleanup errors fail the job on self-hosted
runners and are warnings on GitHub-hosted runners. This supports
sequential reuse of persistent runners; simultaneous jobs on the same host are
not supported. Partial recovery state is preserved rather than forcibly deleted.

The caller must grant `id-token: write`. The standalone
[`socket-sts`](../socket-sts) action provides the generated token, revokes it
when the job finishes, and limits its lifetime with the STS lease expiration.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On such a run, the action emits a warning
annotation that package-policy enforcement is disabled, mirrors it into the
job's step summary, and performs no other
work: it does not exchange tokens, download Aegis, install a firewall, or inspect
downloads. Both outputs are empty. Any other event without an OIDC token fails,
since that means the job is missing `id-token: write`.

Every later stage degrades instead of failing the job. Each stage runs only if
the previous one succeeded: the Socket STS token exchange, the GitHub STS
exchange for the Aegis release download token, the GitHub CLI bootstrap, the
Aegis release download and verification, the token provider, the lifecycle
handler, and finally the package installation. When one of them fails after its
own retries, nothing after it runs, so Aegis is never installed without a Socket
API token and no unverified release is ever installed. A final step then emits a
warning annotation titled "Package-policy enforcement disabled" that names the
stage that failed and points at its step log, mirrors it into the job's step
summary, and the job continues without a
package firewall: package downloads are not inspected or blocked, and both
outputs are empty. A checksum or provenance mismatch is reported the same way;
it also installs nothing. The step that fails is still marked failed in the job
log, so an outage of the Socket STS, the GitHub STS, GitHub releases, or Aegis
itself is visible without halting the run.

Aegis does not permit API keys in installation JSON. On enforcing runs, the action keeps the
masked STS token in a detached process and gives Aegis an unguessable,
loopback-only `test_token_url` in a mode-0600 configuration file. The installed
service can fetch the token after its native service manager starts without
writing the credential to disk.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `socket-sts-host` | Socket STS hostname, without a scheme, port, or path | No | `socket-sts.tempoxyz.net` |

## Outputs

| Name | Description |
|------|-------------|
| `firewall-path-binary` | Path to the installed Aegis binary |
| `firewall-path-report` | Path to the Aegis audit log |

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: tempoxyz/gh-actions/actions/socket-firewall@<commit-sha>

  # Supported package-manager downloads are now routed through Aegis.
  - run: pnpm install --frozen-lockfile
```

## GitHub runner identity

The installed Aegis service does not inherit the workflow environment. Setup
therefore passes the GitHub OIDC request URL and request bearer to the detached
provider through private IPC, alongside the Socket token. These credentials are
not written to install JSON, command arguments, child environment variables, or
logs. The provider continues to use a random route bound to `127.0.0.1`.

Legacy empty POST requests return `{"token":"<Socket token>"}` immediately.
Clients supporting the identity extension can POST
`{"github_oidc_audience":"https://aegis.tempoxyz.net"}` to the same route. On
successful GitHub OIDC acquisition, the response additionally includes
`"github_oidc_jwt":"<raw JWT>"`. The client is responsible for base64 encoding
that JWT into its `X-Aegis-GitHub-OIDC-JWT` header; the provider does not encode it.
The legacy `https://aegis.tempoxyz.dev` audience remains supported during the
client migration. No other audience is supported, and tokens for the two
audiences are acquired and cached independently.

OIDC acquisition is on demand, capped at 1.5 seconds, and never follows redirects.
Concurrent requests share acquisition. Tokens stay in memory, refresh near
expiry, and are never served after expiry; failed acquisition is throttled for
one minute. Missing credentials, permission errors, or outages omit the optional
JWT but still return the Socket token. Legacy clients do not trigger OIDC calls.

Rollout requires an Aegis release containing the client support from
[Aegis PR #102](https://github.com/tempoxyz/aegis/pull/102). Older releases remain
compatible but will not request runner identity. Identity consumers must verify
the JWT signature, issuer, audience, and lifetime before trusting its claims;
the provider's claim parsing only manages freshness and audience selection.

Run `node --test actions/socket-firewall/*.test.js` for local coverage. Trusted
CI additionally enables `AEGIS_LIVE_GITHUB_OIDC=true` for the provider test to
exercise real runner acquisition through the detached process and HTTP handoff
without printing credentials or claims.
