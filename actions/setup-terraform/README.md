# Setup Terraform

Install a Terraform release verified against HashiCorp's GPG-signed `SHA256SUMS`. Replaces
`hashicorp/setup-terraform`, which downloads without verifying a signature and installs a
stdout-capturing wrapper script by default.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Exact Terraform version, e.g. `1.14.7`. Version constraints and `latest` are rejected. | No | `1.14.7` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-terraform@main

  - uses: tempoxyz/gh-actions/actions/setup-terraform@main
    with:
      version: 1.9.8
```

## How it verifies

HashiCorp signs every release's `terraform_<version>_SHA256SUMS` with the HashiCorp Security key
(primary fingerprint `C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`, published at
<https://www.hashicorp.com/.well-known/pgp-key.txt>). That key is pinned in this directory as
[`hashicorp.asc`](hashicorp.asc). The action imports it into a throwaway keyring, requires a
`VALIDSIG` from that primary key on the checksums file, and only then checks the zip against the
signed checksums. `gpg` is preinstalled on GitHub-hosted runners.

Behaviour matches `hashicorp/setup-terraform` with `terraform_wrapper: false`: the real binary is
on `PATH`, and no `stdout`/`exitcode` step outputs are produced.
