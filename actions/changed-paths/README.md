# Changed paths

Conditional CI: one `true`/`false` output per named filter, computed from the files changed
between the event's base and head. Replaces `dorny/paths-filter` for the `filters` + per-filter
outputs usage. Changed files come from GitHub's compare API, so no `fetch-depth` is needed.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `filters` | YAML map `name: [globs]`; `!glob` excludes | Yes | |
| `base` / `head` | Commits to compare | No | derived from the event |
| `token` | Token for the compare API | No | `${{ github.token }}` |
| `list-files` | `json` to also output `<name>_files` | No | `none` |

## Outputs

Per filter: `<name>` (`true`/`false`) and `<name>_count`; plus `changes`, a JSON array of the
filters that matched. Outputs are step outputs, so give the step an `id`.

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/changed-paths@main
  id: filter
  with:
    filters: |
      specs:
        - 'crates/contracts/**'
        - '!crates/contracts/CHANGELOG.md'
      smoke:
        - 'Cargo.lock'
- if: steps.filter.outputs.specs == 'true'
  run: ...
```

Globs support `**`, `*`, `?` and `{a,b}`; a path matches a filter when it matches a positive
pattern and no negated one. Matching logic lives in `match.mjs` and is unit-tested.
