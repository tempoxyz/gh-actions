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

For tokens whose exchange response includes `d1_read` or `d1_write` permissions,
the action checks D1 readiness before emitting token outputs. Using the same
minted token from the runner, it lists databases in the selected account and
executes `SELECT 1 /* Cloudflare STS health check */` against the first returned
database. The query reads no application tables and changes no data. No database
ID needs to be configured, and token account and IP restrictions remain unchanged.

Discovery and query requests share one 30-second deadline, shortened to the token
expiration time. Network errors, authentication errors (including Cloudflare code
`10000`), HTTP `408`, `425`, `429`, and `5xx` retry with exponential backoff from
250 ms, capped at four seconds. HTTP timeouts and waits fit the remaining budget,
and `Retry-After` is honored. Missing databases, invalid responses, other errors,
or an elapsed deadline fail the action without exposing the token as an output;
post-job cleanup still revokes the saved token. A successful probe confirms the
SELECT request works, not that every write operation is authorized.

Deploy the STS service's `permissions` response field before adopting this action.
Older services without that field remain compatible but emit a warning that D1
readiness could not be checked. Tokens explicitly reporting no D1 permission
make no D1 requests.

Before requesting OIDC, the action asks the STS whether it is serving exchanges
with one empty `POST /status`. A paused STS answers
`{"status":"disabled","reason":"Paused"}`; the action then emits a warning
annotation titled "Cloudflare STS disabled" naming the reason and fails at once,
since the job needs the token, rather than retrying for the rest of the budget.
Any other answer to the probe, or none, is inconclusive and the exchange proceeds.

## Tests

```sh
node --test actions/cloudflare-sts/*.test.js
```

The repository's Action Tests workflow discovers these tests automatically.
