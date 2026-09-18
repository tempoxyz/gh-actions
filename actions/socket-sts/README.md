# Socket STS

Exchange the calling GitHub Actions job's OIDC token for a short-lived Socket
API token. The token is masked before it is published as an action output and
is revoked automatically when the job finishes. The Socket STS lease also
limits the token lifetime.

The caller must grant `id-token: write`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `dev` | Use the development Socket STS endpoint for integration testing | No | `false` |

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
