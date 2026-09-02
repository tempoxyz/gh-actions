# Setup mold

Install the [mold](https://github.com/rui314/mold) linker (2.42.0) and make it the default
linker. Replaces `rui314/setup-mold`, which piped an unverified download into `tar`; mold
publishes no checksums or signatures, so the release tarball digests are pinned in the action
and change together with the version.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `make-default` | Point `/usr/bin/ld` at mold | No | `true` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/setup-mold@main
```

`setup-rust-build` includes the same install for Rust jobs that also need the toolchain and
sccache; `test.yml` keeps every copy of the pinned version and digests identical.
