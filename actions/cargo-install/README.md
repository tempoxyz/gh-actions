# cargo install (cached)

`cargo install` a tool and cache the resulting binary (`~/.cargo/bin/<tool>`) keyed on tool,
version, features, rustc version and platform. Replaces `taiki-e/cache-cargo-install-action`
using only `actions/cache`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `tool` | Crate to install | Yes | |
| `version` | Exact version; newest on crates.io when empty | No | `""` |
| `locked` | Pass `--locked` | No | `true` |
| `features` | Comma-separated features | No | `""` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-rust-build@main
  - uses: tempoxyz/gh-actions/actions/cargo-install@main
    with:
      tool: zepter
```

Pin `version` for reproducible builds; with it empty the cache key says `latest` and is only
refreshed when the rustc version changes.
