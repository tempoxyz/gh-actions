# Setup Argo CLI

Install Argo Workflows CLI.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Argo CLI version (e.g., `v3.6.2`). Defaults to latest. | No | `latest` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-argo-cli@main

  - uses: tempoxyz/gh-actions/actions/setup-argo-cli@main
    with:
      version: v3.6.2
```
