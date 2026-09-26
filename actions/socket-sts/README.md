# Socket STS

Exchange the calling GitHub Actions job's OIDC token for a short-lived Socket
API token. The token is masked before it is published as an action output and
is revoked automatically when the job finishes. The Socket STS lease also
limits the token lifetime. Revocation is best-effort: if the STS cannot serve it
after retries, the post-job handler reports a warning instead of failing the
job, since the lease expiration still bounds the token.

Socket STS is a `node24` action, so its main and post-job handlers use the
runner-bundled executable that it exposes as `node-path` for Aegis.
They do not rely on a system `node` installation or on `node` being available
on `PATH`; this is the same self-hosted-runner-safe runtime model introduced in
[#199](https://github.com/tempoxyz/gh-actions/pull/199).

The caller must grant `id-token: write`.

One 90-second budget, matching the GitHub STS default, covers the whole
exchange: OIDC requests, STS requests, their retries, assertion refreshes, and
rate-limit waits. Each request is bounded by ten seconds or the remaining budget,
whichever is smaller, and exponential backoff carries up to 25% jitter so
parallel jobs do not retry in lockstep. An explicit `Socket API rate limit
exceeded` response consumes the OIDC assertion, so the next retry obtains a
fresh assertion after waiting.
An `exchange is already in progress` 429 retains the assertion to retrieve the
original token when creation completes. Other 429 responses also retain it.
Transport timeouts and explicit token-creation timeouts retain the existing
limit of one fresh-assertion recovery attempt.

Before exchanging, the action asks the STS whether it is serving exchanges with
one empty `POST /status`. A paused STS answers
`{"status":"disabled","reason":"Paused"}`; the action then emits a warning
annotation titled "Socket STS disabled" naming the reason and fails at once,
since the job needs the token, rather than retrying for the rest of the budget.
Any other answer to the probe, or none, is inconclusive and the exchange proceeds.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `host` | Socket STS hostname, without a scheme, port, or path | No | `socket-sts.tempoxyz.net` |
| `upload-aegis-report` | Upload the final Aegis audit log after the job finishes | No | `true` |

When `upload-aegis-report` is `true`, the post-job handler uploads the final
Aegis service log as a seven-day artifact. It reports a missing log or artifact
service failure as a warning, preserving the job's original result.

## Outputs

| Name | Description |
|------|-------------|
| `token` | Sensitive short-lived Socket API token, registered with GitHub's secret masker |
| `expires-at` | Time when Socket STS will revoke the token |
| `node-path` | Absolute path to the runner-provided Node executable; usable by later steps without installing Node |

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Exchange GitHub OIDC token for a Socket token
    id: socket-token
    uses: tempoxyz/gh-actions/actions/socket-sts@<commit-sha>

  - name: Use the Socket API
    env:
      SOCKET_API_TOKEN: ${{ steps.socket-token.outputs.token }}
    run: ./use-socket-api
```
