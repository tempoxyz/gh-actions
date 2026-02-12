# Docker Login

Log in to GHCR and optionally Docker Hub.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `ghcr-token` | GitHub token for GHCR login | Yes | |
| `dockerhub-username` | Docker Hub username (if omitted, Docker Hub login is skipped) | No | `""` |
| `dockerhub-token` | Docker Hub token | No | `""` |

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/docker-login@main
  with:
    ghcr-token: ${{ secrets.GITHUB_TOKEN }}

# With Docker Hub
- uses: tempoxyz/gh-actions/actions/docker-login@main
  with:
    ghcr-token: ${{ secrets.GITHUB_TOKEN }}
    dockerhub-username: ${{ vars.DOCKER_HUB_USER }}
    dockerhub-token: ${{ secrets.DOCKER_HUB_TOKEN }}
```
