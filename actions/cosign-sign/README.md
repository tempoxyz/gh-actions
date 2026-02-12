# Cosign Sign

Install cosign and sign container images.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `images` | Newline-separated list of image references to sign | Yes | |
| `cosign-version` | Cosign version to install (leave empty for default) | No | `""` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/cosign-sign@main
    with:
      images: |
        ghcr.io/tempoxyz/tempo:latest
        ghcr.io/tempoxyz/tempo:v1.0.0
```
