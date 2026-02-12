# Setup Rust Build

Install Rust toolchain, mold linker, and sccache.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `toolchain` | Rust toolchain (stable, nightly, or specific version) | No | `stable` |
| `components` | Comma-separated Rust components (e.g., `clippy,rustfmt`) | No | `""` |
| `targets` | Comma-separated Rust targets | No | `""` |
| `mold` | Install mold linker | No | `true` |
| `sccache` | Enable sccache | No | `true` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-rust-build@main

  - uses: tempoxyz/gh-actions/actions/setup-rust-build@main
    with:
      toolchain: nightly
      components: clippy,rustfmt
```
