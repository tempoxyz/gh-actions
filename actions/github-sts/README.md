# GitHub STS

Exchange a workflow's GitHub OIDC token for a short-lived limited-permission GitHub App token.

The caller must grant `id-token: write`. The action does not require stored
credentials: the STS verifies the signed GitHub OIDC token and authorizes it
against the trust policy in the target repository.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `scope` | Repository (`org/repo`) or organization whose trust policy to use | No | Current repository |
| `policy` | Trust policy name (fetches file in `.github/sts/<policy>.sts.yaml` within `scope` repo) | Yes | |

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
  - name: Fetch GitHub token via STS
    id: sts
    uses: tempoxyz/gh-actions/actions/github-sts@main
    with:
      policy: deploy # Uses .github/sts/deploy.sts.yaml as the permissions policy

  - name: Use the token
    env:
      GH_TOKEN: ${{ steps.sts.outputs.token }}
    run: gh api "repos/${GITHUB_REPOSITORY}"
```

The minted installation token is revoked automatically when the job finishes,
including after a failed or cancelled job. If the STS exchange is rejected,
the action prints the HTTP status and the server's safe error message (for
example, `trust policy: subject did not match`) to make policy and
configuration problems easier to diagnose.

OIDC requests, STS worker exchanges, and token revocations retry transient
network errors and HTTP `408`, `425`, `429`, or `5xx` responses up to five
times after the initial attempt, with exponential backoff (1, 2, 4, 8, and
16 seconds). Other failures are returned immediately.
