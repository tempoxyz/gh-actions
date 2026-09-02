# Check needs

Gate job for matrices and fan-outs: fails unless every job listed in `needs` succeeded. Replaces
`re-actors/alls-green` with the same inputs.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `jobs` | Pass `${{ toJSON(needs) }}` | Yes | |
| `allowed-skips` | Job names that may be `skipped` | No | `""` |
| `allowed-failures` | Job names that may be `failure` | No | `""` |

## Usage

```yaml
jobs:
  ci-success:
    if: always()
    needs: [build, test, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: tempoxyz/gh-actions/actions/check-needs@main
        with:
          jobs: ${{ toJSON(needs) }}
          allowed-skips: lint
```

Use `if: always()` on the gate job so it runs (and fails) when a dependency failed; a
`cancelled` result always fails. Logic lives in `check.mjs` and is unit-tested.
