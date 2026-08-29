# Socket Firewall

Install Socket Firewall Enterprise with a short-lived Socket API token derived
from the calling job's GitHub OIDC identity. The STS associates the token with
the caller's repository and records its workflow, run, attempt, and initiating
GitHub actor.

The caller must grant `id-token: write`. The generated token is revoked when
the job finishes and is also covered by the STS lease expiration.

## Outputs

| Name | Description |
|------|-------------|
| `firewall-path-binary` | Path to the installed Socket Firewall binary |
| `firewall-path-report` | Path to the generated Socket Firewall report JSON |

## Usage

Pin this action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: tempoxyz/gh-actions/actions/socket-firewall@<commit-sha>

  # Supported package-manager commands are now routed through Socket Firewall.
  - run: pnpm install --frozen-lockfile
```
