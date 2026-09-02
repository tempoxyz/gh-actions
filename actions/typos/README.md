# typos

Spell-check source files with [typos](https://github.com/crate-ci/typos), installed from a
release asset verified with `gh release verify-asset` (GitHub's release attestation). Replaces the
`crate-ci/typos` action with the same target, annotations and exit status.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `version` | Immutable typos release tag | No | `v1.49.0` |
| `files` | Paths to check, space separated | No | `.` |
| `config` | typos config file (auto-discovery otherwise) | No | `""` |
| `extra-args` | Extra `typos` arguments | No | `""` |

## Usage

```yaml
steps:
  - uses: actions/checkout@...
  - uses: tempoxyz/gh-actions/actions/typos@main
```

Findings are emitted as GitHub annotations and the step fails when any typo is found. The
`rust-lint` reusable workflow installs typos with the same script inline; `test.yml` keeps the
two pinned versions equal.
