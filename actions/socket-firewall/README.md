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
After Aegis is installed, the action registers a dedicated post-job handler to
upload the final log as a seven-day `aegis-service-log-<job>-aegis-report`
artifact. Upload failures are warnings and do not hide the original job result.

The caller must grant `id-token: write`. The standalone
[`socket-sts`](../socket-sts) action provides the generated token, revokes it
when the job finishes, and limits its lifetime with the STS lease expiration.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On such a run, the action emits a warning
annotation that package-policy enforcement is disabled and performs no other
work: it does not exchange tokens, download Aegis, install a firewall, or inspect
downloads. Both outputs are empty. Any other event without an OIDC token fails,
since that means the job is missing `id-token: write`.

Aegis does not permit API keys in installation JSON. On enforcing runs, the action keeps the
masked STS token in a detached process and gives Aegis an unguessable,
loopback-only `test_token_url` in a mode-0600 configuration file. The installed
service can fetch the token after its native service manager starts without
writing the credential to disk.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `dev` | Use the development Socket STS endpoint for integration testing | No | `false` |

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
