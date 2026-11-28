# Docker STS

Exchange the job's GitHub Actions OIDC token for a short-lived Docker Hub
organization access token. The job needs `permissions: id-token: write` and a
matching [Docker STS policy](https://github.com/tempoxyz/docker-sts#policies).

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `policy` | Docker STS policy name | Yes | |
| `ttl` | Requested lifetime in minutes, from `5m` to `60m`. The policy may cap it. | No | `15m` |

The action returns one output, `token`. Use it as the Docker Hub password with
`tempoxyz` as the username.

```yaml
permissions:
  id-token: write

steps:
  - uses: tempoxyz/gh-actions/actions/docker-sts@main
    id: docker-sts
    with:
      policy: my-docker-policy
      ttl: 5m

  - uses: tempoxyz/gh-actions/actions/docker-login@main
    with:
      ghcr-token: ${{ github.token }}
      dockerhub-username: tempoxyz
      dockerhub-token: ${{ steps.docker-sts.outputs.token }}
```
