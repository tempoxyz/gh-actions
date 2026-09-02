# Setup pinact

Install [pinact](https://github.com/suzuki-shunsuke/pinact), the GitHub Actions pin checker
and fixer, as a plain binary. Replaces `suzuki-shunsuke/pinact-action`, which installs the same
binary through aqua from inside a 6 MB Node bundle.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Immutable pinact release tag (e.g., `v4.1.1`). Mutable `latest` is rejected. | No | `v4.1.1` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-pinact@main

  - name: Check action pins
    env:
      GITHUB_TOKEN: ${{ github.token }}
    run: pinact run -fix=false --verify-min-age
```

The action downloads `pinact_linux_<arch>.tar.gz` and verifies it against
`pinact_<version>_checksums.txt` from the same release before installing it. Flags map
one-to-one onto the old action's inputs: `fix: "false"` is `-fix=false`, `no_api` is
`--no-api`, `verify` is `--verify`, `verify_min_age` is `--verify-min-age`, `includes` is
`-i <regex>`, `config` is `-c <path>`, and `github_token` is the `GITHUB_TOKEN` environment
variable. A global policy file can still be supplied through `PINACT_GLOBAL_CONFIG`.

The reusable [`scan-github-actions`](../../.github/workflows/scan-github-actions.yml) workflow
installs pinact with the same script inline, because a reusable workflow cannot reference a
composite in this repository without checking the repository out into the caller's workspace,
where the scanners would then pick it up. A test in `test.yml` keeps the two pinned versions equal.
