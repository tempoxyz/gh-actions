# Setup Argo CLI

Install Argo Workflows CLI.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Immutable Argo CLI release tag (e.g., `v3.6.4`). Mutable `latest` is rejected. | No | `v3.6.4` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-argo-cli@main

  - uses: tempoxyz/gh-actions/actions/setup-argo-cli@main
    with:
      version: v3.6.4
```

The action downloads `argo-linux-amd64.gz` and verifies it against Argo's `argo-workflows-cli-checksums.txt` from the same release before installing it.
