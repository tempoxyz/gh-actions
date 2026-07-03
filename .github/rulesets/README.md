# Repository rulesets

`main.json` mirrors the active `main` repository ruleset and requires these CI checks on the default branch:

- `CI / Scan GitHub Actions`
- `Test / integration`

Apply it with:

```sh
gh api \
  --method PUT \
  repos/tempoxyz/gh-actions/rulesets/18387257 \
  --input .github/rulesets/main.json
```
