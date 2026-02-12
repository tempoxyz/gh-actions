# Docker Metadata Tags

Generate Docker metadata with the standard Tempo tagging strategy.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `images` | Newline-separated list of image names | Yes | |
| `bake-target` | Docker Bake target name (leave empty if not using bake) | No | `""` |
| `nightly` | Enable nightly tag | No | `false` |
| `include-sha` | Include `sha-<short>` tag | No | `true` |
| `include-latest` | Include `latest` tag on default branch | No | `true` |
| `include-pr` | Include PR tag | No | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `tags` | Generated tags |
| `labels` | Generated labels |
| `bake-file` | Bake file path (if `bake-target` set) |

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/docker-metadata-tags@main
  id: meta
  with:
    images: |
      ghcr.io/tempoxyz/tempo
      docker.io/tempoxyz/tempo
    bake-target: tempo
```
