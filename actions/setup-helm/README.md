# Setup Helm

Install a Helm release verified against the Helm maintainers' GPG signatures. Replaces
`azure/setup-helm`, which downloads from `get.helm.sh` without checking a signature and defaults
to the moving `latest`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Immutable Helm release tag, e.g. `v4.2.4`. `latest` is rejected. | No | `v4.2.4` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-helm@main

  - uses: tempoxyz/gh-actions/actions/setup-helm@main
    with:
      version: v4.1.1
```

## How it verifies

Every Helm release ships a detached GPG signature per archive (`.asc`, attached to the GitHub
release) made by one of the maintainers listed in the project's
[`KEYS`](https://github.com/helm/helm/blob/main/KEYS) file. That file is pinned here as
[`helm-KEYS.asc`](helm-KEYS.asc) and is the trust anchor: the action imports it into a throwaway
keyring, checks the `.sha256sum` from `get.helm.sh`, and requires a valid, unexpired signature
from a pinned key on the archive. Updating the keyring is a reviewed change to this repository.
`gpg` is preinstalled on GitHub-hosted runners.

The runner image ships Helm 3.x; use this action when a repository needs Helm 4.
