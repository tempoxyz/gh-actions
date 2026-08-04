# GitHub STS

Exchange a workflow's GitHub OIDC token for a short-lived limited-permission GitHub App token.

The caller must grant `id-token: write` and pass the organization secrets as
action inputs. Composite actions cannot access the caller workflow's `secrets`
context directly.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `scope` | Repository (`org/repo`) or organization whose trust policy to use | No | Current repository |
| `policy` | Trust policy name (fetches file in `.github/sts/<policy>.sts.yaml` within `scope` repo) | Yes | |
| `client-cert` | PEM-encoded client certificate | Yes | |
| `client-key` | PEM-encoded client private key | Yes | |

## Outputs

| Name | Description |
|------|-------------|
| `token` | Short-lived GitHub App installation token |
| `expires-at` | Token expiration timestamp |

## Production usage

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Exchange OIDC token
    id: sts
    uses: tempoxyz/gh-actions/actions/github-sts@main
    with:
      policy: deploy # Uses .github/sts/deploy.sts.yaml as the permissions policy
      client-cert: ${{ secrets.GH_STS_PRD_CLIENT_CERT }}
      client-key: ${{ secrets.GH_STS_PRD_CLIENT_KEY }}

  - name: Use the token
    env:
      GH_TOKEN: ${{ steps.sts.outputs.token }}
    run: gh api "repos/${GITHUB_REPOSITORY}"
```

The certificate and key are held in memory for the exchange and are not
logged. The minted installation token is revoked automatically when the job
finishes, including after a failed or cancelled job. If the STS exchange is
rejected, the action prints the HTTP status and the server's safe error
message (for example, `trust policy: subject did not match`) to make policy
and configuration problems easier to diagnose.
