# Cosign Sign

Install cosign and sign container images.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `images` | Newline-separated list of image references to sign | Yes | |
| `cosign-version` | Cosign version to install (e.g., `v3.1.4`) | No | `v3.1.4` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/cosign-sign@main
    with:
      images: |
        ghcr.io/tempoxyz/tempo:latest
        ghcr.io/tempoxyz/tempo:v1.0.0
```
