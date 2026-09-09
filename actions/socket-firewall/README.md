# Socket Firewall

Install Socket Firewall Enterprise with a short-lived Socket API token derived
from the calling job's GitHub OIDC identity. The STS associates the token with
the caller's repository and records its workflow, run, attempt, and initiating
GitHub actor.

The caller must grant `id-token: write`. The generated token is revoked when
the job finishes and is also covered by the STS lease expiration.

GitHub never issues an OIDC token to `pull_request` runs from forks, whatever
permissions the workflow declares. On a `pull_request` run without an OIDC token
the action emits a warning annotation, skips the Socket STS exchange, and installs
Socket Firewall Free instead of Enterprise. Free needs no token and blocks known
malware with Socket's default policy, but does not apply organization policies or
triage, and fronts only the npm, Python, and Rust package managers. Any other event
without an OIDC token fails, since that means the job is missing `id-token: write`.

On Windows, the wrapper copies the upstream installer's verified `sfw` binary
to `sfw.exe` so the package-manager `.cmd` shims can execute it. The binary
output points to `sfw.exe`; the original file is retained for upstream cleanup.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `dev` | Use the development Socket STS endpoint for integration testing | No | `false` |

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
