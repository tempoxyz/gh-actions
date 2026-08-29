# Cloudflare STS

Exchange a workflow's GitHub OIDC token for a short-lived, policy-scoped
Cloudflare API token. The STS also restricts the token to the requesting runner's
observed IP address and names it after the workflow run that requested it.

The caller must grant `id-token: write`. The action does not require a stored
Cloudflare credential: the STS verifies the signed GitHub OIDC token and
authorizes it against the centrally reviewed policy in `cloudflare-sts`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `policy` | Trust policy name | Yes | |
| `ttl` | Token lifetime with an `s`, `m`, or `h` suffix; maximum `1h` | No | `15m` |
| `dev` | Use `cf-sts.tehq.dev` instead of production | No | `false` |

## Outputs

| Name | Description |
|------|-------------|
| `token` | Short-lived Cloudflare API token |
| `expires-at` | Token expiration timestamp |
| `account-id` | Cloudflare account ID for the selected environment |

## Usage

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Fetch Cloudflare token via STS
    id: sts
    uses: tempoxyz/gh-actions/actions/cloudflare-sts@main
    with:
      policy: deploy
      ttl: 5m

  - name: Use the token
    env:
      CLOUDFLARE_API_TOKEN: ${{ steps.sts.outputs.token }}
      CLOUDFLARE_ACCOUNT_ID: ${{ steps.sts.outputs.account-id }}
    run: pnpm exec wrangler deploy
```

The default lifetime is 15 minutes. `45s`, `5m`, and `1h` are valid examples;
zero, compound or fractional values, and durations longer than one hour are
rejected before an OIDC token is requested.

OIDC requests and STS exchanges retry transient network errors and HTTP `408`,
`425`, `429`, or `5xx` responses up to five times after the initial attempt,
with exponential backoff (1, 2, 4, 8, and 16 seconds). Other failures are
returned immediately.
