# Socket Firewall

Install Aegis with a short-lived Socket API token derived from the calling
job's GitHub OIDC identity. The Socket STS associates the token with the
caller's repository and records its workflow, run, attempt, and initiating
GitHub actor.

The action uses GitHub STS policy `download-releases` in `tempoxyz/aegis` to
download the native artifact for the runner operating system and architecture
from release `20260915T010858Z-9c8efabdc447`. Before installation, it verifies
the artifact against `SHA256SUMS` and the release's Sigstore provenance bundle,
including the signer workflow and source commit.

The caller must grant `id-token: write`. The generated token is revoked when
the job finishes and is also covered by the STS lease expiration.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On such a run, the action emits a warning
and preserves the previous Socket Firewall Free fallback. Any other event
without an OIDC token fails, since that means the job is missing
`id-token: write`.

Aegis does not permit API keys in installation JSON. The action keeps the
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
| `firewall-path-binary` | Path to the installed Aegis binary (or fork fallback binary) |
| `firewall-path-report` | Path to the Aegis audit log (or fork fallback report JSON) |

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
