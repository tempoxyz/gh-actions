# Docker Build & Push

Build and push a Docker image to a container registry using Buildx.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `context` | Docker build context | Yes | |
| `file` | Dockerfile path (relative to context) | No | `""` |
| `image` | Full image name (e.g. `ghcr.io/tempoxyz/myapp`) | Yes | |
| `tags` | Additional tags (newline-separated) | No | `""` |
| `include-sha-tag` | Add `image:sha-<short>` to the tag list | No | `true` |
| `labels` | Image labels (newline-separated) | No | `""` |
| `platforms` | Target platforms | No | `linux/amd64` |
| `push` | Push the image | No | `true` |
| `build-args` | Build arguments (newline-separated `KEY=VALUE`) | No | `""` |
| `target` | Docker build target | No | `""` |
| `cache-from` | Cache sources | No | `""` |
| `cache-to` | Cache destinations | No | `""` |
| `provenance` | Generate provenance attestations | No | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `short-sha` | 7-char short SHA of the commit |
| `digest` | Image digest from `docker/build-push-action` |

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/docker-build-push@main
  with:
    context: .
    image: ghcr.io/tempoxyz/myapp
    tags: |
      ghcr.io/tempoxyz/myapp:latest
```

To pass a precomputed tag and label set without the automatic SHA tag:

```yaml
- uses: tempoxyz/gh-actions/actions/docker-build-push@main
  with:
    context: .
    image: ghcr.io/tempoxyz/myapp
    include-sha-tag: "false"
    tags: ${{ steps.meta.outputs.tags }}
    labels: ${{ steps.meta.outputs.labels }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
    provenance: "false"
```
