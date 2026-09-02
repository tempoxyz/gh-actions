# Setup Rust Build

Install Rust toolchain, mold linker, and sccache.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `toolchain` | Rust toolchain (stable, nightly, or specific version) | No | `stable` |
| `components` | Comma-separated Rust components (e.g., `clippy,rustfmt`) | No | `""` |
| `targets` | Comma-separated Rust targets | No | `""` |
| `mold` | Install the mold linker (2.42.0, tarball digest pinned in the action since mold publishes no checksums or signatures) and make it the default linker | No | `true` |
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
