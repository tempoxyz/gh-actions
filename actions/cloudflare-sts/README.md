# Cloudflare STS

Exchange a GitHub Actions OIDC token for a short-lived Cloudflare API token.
The token is masked before being emitted as an output. A post-job hook uses a
fresh OIDC token to revoke and delete it when the job finishes.

The caller must grant `id-token: write` and be authorized by the selected STS
trust policy. The action runs on the runner-provided Node.js 24 runtime and
requires no dependency installation.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `account` | Cloudflare account alias (`dev`, `prd`, or `infra`) | Yes | |
| `policy` | STS trust policy name | Yes | |
| `ttl` | Requested token lifetime, such as `45s`, `5m`, or `1h`; maximum one hour | No | `15m` |
| `host` | STS hostname, without a scheme, port, or path | No | `cf-sts.tempoxyz.net` |

The service enforces the policy's permissions, supported accounts, and maximum
token lifetime. The action uses `host` for HTTPS requests and the OIDC audience,
and saves it for cleanup. For a custom endpoint, set `host: sts.example.com`.

## Outputs

| Name | Description |
|------|-------------|
| `token` | Sensitive short-lived Cloudflare API token |
| `expires-at` | Token expiration timestamp |
| `account-id` | Cloudflare account ID for the selected alias |

## Usage

Pin the action to a full commit SHA in production:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Fetch Cloudflare token
    id: cloudflare-sts
    uses: tempoxyz/gh-actions/actions/cloudflare-sts@<commit-sha>
    with:
      account: prd
      policy: deploy
      ttl: 5m

  - name: Use the Cloudflare token
    env:
      CLOUDFLARE_API_TOKEN: ${{ steps.cloudflare-sts.outputs.token }}
      CLOUDFLARE_ACCOUNT_ID: ${{ steps.cloudflare-sts.outputs.account-id }}
    run: ./deploy.sh
```

The private token ID is saved in action state for cleanup and is not exposed as
an output. Cleanup uses `DELETE /sts/exchange` and can authenticate after the
minted Cloudflare token expires. If no token was minted, cleanup is skipped.

OIDC, exchange, and cleanup requests retry network errors and HTTP `408`, `425`,
`429`, or `5xx` responses up to five times, using exponential backoff. Each retry
sequence has a 90-second budget, including HTTP requests and waits. Requests have
a 10-second wall-clock timeout, shortened to fit the remaining budget. A `429`
response's `Retry-After` (seconds or HTTP date) is honored; if it cannot fit in the
budget, the action fails without retrying early. Retries reuse the OIDC assertion.

## Tests

```sh
node --test actions/cloudflare-sts/*.test.js
```

The repository's Action Tests workflow discovers these tests automatically.
