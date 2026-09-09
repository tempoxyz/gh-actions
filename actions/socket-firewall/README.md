# Socket Firewall

Install Socket Firewall Enterprise with a short-lived Socket API token derived
from the calling job's GitHub OIDC identity. The STS associates the token with
the caller's repository and records its workflow, run, attempt, and initiating
GitHub actor.

The caller must grant `id-token: write`. The generated token is revoked when
the job finishes and is also covered by the STS lease expiration.

On Windows, the wrapper copies the upstream installer's verified `sfw` binary
to `sfw.exe` so the package-manager `.cmd` shims can execute it. The binary
output points to `sfw.exe`; the original file is retained for upstream cleanup.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `dev` | Use the development Socket STS endpoint for integration testing | No | `false` |
| `shims` | Automatically wrap package managers; set to `false` for explicit Firewall commands | No | `true` |

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

For download-only jobs, set `shims: false`, give the action an `id`, and invoke
its `firewall-path-binary` output explicitly (for example, `"$SFW" cargo fetch
--locked`). Later commands are not automatically protected in this mode. This
does not disable the Firewall for commands explicitly run through that binary.
