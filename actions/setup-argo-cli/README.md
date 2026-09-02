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

The action downloads `argo-linux-amd64.gz`, `argo-workflows-cli-checksums.txt` and
`argo-workflows-cli-checksums.sig` from the release. Argo signs the checksums file with a fixed
cosign key (`cosign sign-blob --key`); the signature is verified with `openssl` against the public
key pinned in this directory ([`argo-cosign.pub`](argo-cosign.pub), copied from `cosign.pub` in
the argo-workflows repository, unchanged since v3.5), and only then is the binary checked against
the checksums file. Nothing served alongside the release is trusted on its own.
