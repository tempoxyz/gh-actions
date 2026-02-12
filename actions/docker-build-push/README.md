# Docker Build & Push

Build and push a Docker image to a container registry using Buildx.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `context` | Docker build context | Yes | |
| `file` | Dockerfile path (relative to context) | No | `""` |
| `image` | Full image name (e.g. `ghcr.io/tempoxyz/myapp`) | Yes | |
| `tags` | Additional tags (newline-separated) | No | `""` |
| `platforms` | Target platforms | No | `linux/amd64` |
| `push` | Push the image | No | `true` |
| `build-args` | Build arguments (newline-separated `KEY=VALUE`) | No | `""` |
| `target` | Docker build target | No | `""` |
| `cache-from` | Cache sources | No | `""` |
| `cache-to` | Cache destinations | No | `""` |

## Outputs

| Name | Description |
|------|-------------|
| `short-sha` | 7-char short SHA of the commit |

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/docker-build-push@main
  with:
    context: .
    image: ghcr.io/tempoxyz/myapp
    tags: |
      ghcr.io/tempoxyz/myapp:latest
```
