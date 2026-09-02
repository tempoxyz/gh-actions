# GitHub release

Create a release if the tag has none, otherwise update it, then upload assets, replacing any
with the same name. A thin wrapper over `gh release`; replaces `softprops/action-gh-release`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `token` | Token with `contents: write` | No | `${{ github.token }}` |
| `tag` | Release tag (created at `target` if missing) | No | `${{ github.ref_name }}` |
| `target` | Commit or branch to tag when creating | No | `""` |
| `name` | Release title | No | the tag |
| `body` / `body-path` | Release notes inline or from a file | No | `""` |
| `generate-release-notes` | Let GitHub generate notes when creating | No | `false` |
| `draft`, `prerelease` | Release flags | No | `false` |
| `make-latest` | `true`, `false` or `legacy` | No | GitHub default |
| `files` | Newline-separated globs to upload | No | `""` |
| `fail-on-unmatched-files` | Fail when a glob matches nothing | No | `true` |

## Outputs

`url`, `id` of the release.

## Usage

```yaml
permissions:
  contents: write
steps:
  - uses: tempoxyz/gh-actions/actions/gh-release@main
    with:
      tag: ${{ github.ref_name }}
      generate-release-notes: true
      files: |
        dist/*.tar.gz
        dist/checksums.txt
```

Mapping from `softprops/action-gh-release`: `tag_name` → `tag`, `body_path` → `body-path`,
`generate_release_notes` → `generate-release-notes`, `fail_on_unmatched_files` →
`fail-on-unmatched-files`, `make_latest` → `make-latest`. A moving tag such as `latest` works:
the existing release is edited and its assets replaced.
