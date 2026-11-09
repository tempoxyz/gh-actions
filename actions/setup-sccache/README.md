# Setup sccache

Installs sccache with recovery from GitHub release-route outages on Linux. The
upstream action still owns PATH, `SCCACHE_PATH`, Actions cache-service variables,
and post-job statistics. It does not set `RUSTC_WRAPPER` or enable a cache backend:
keep the caller's existing settings (for example, `RUSTC_WRAPPER: sccache`).

```yaml
- uses: tempoxyz/gh-actions/actions/setup-sccache@main # Pin to a released commit in production.
  with:
    version: v0.19.0
```

Inputs match the upstream action: `version` (empty resolves the latest release
once), `token` (defaults to the GitHub.com job token), and `disable_annotations`.
An explicit version must be an exact semantic release tag; no version is silently
upgraded or substituted. The upstream action has no declared action outputs.

## Download and cache contract

Linux requires Bash, Node, curl, Python 3, sha256sum and GNU coreutils. GitHub CLI
is required for latest resolution or API fallback; it is already supplied by
GitHub-hosted Linux runners. No additional bootstrap downloader is introduced.
macOS and Windows continue through the unchanged upstream action; this recovery
path targets the reported Linux failure, not a new cross-platform installer.

On a cache miss, each archive and its `.tar.gz.sha256` file first uses the normal
`mozilla/sccache` release URL. Only recoverable transport failures, HTTP 408/429,
and 500/502/503/504 use GitHub's official release-asset API. Metadata must match
exactly one numeric asset ID for the requested tag and filename on a non-draft
release. Authorization, proxy denials, certificate and other security failures do
not permit fallback. Neither do integrity failures.

Both transports publish files by rename only after completion. Curl uses a
10-second connect timeout and a 60-second low-speed limit; API metadata has a
30-second deadline and API asset streaming fails after 60 seconds without file
growth, with a 5-second termination grace. Ongoing progress has no fixed total
transfer deadline. Authentication remains inside `gh`, fixed to github.com.

The downloaded checksum must be exactly a lowercase SHA-256 digest. It is checked
before extracting only the expected regular executable. This preserves the
upstream checksum trust boundary; sccache's existing action does not require
signed provenance and this wrapper does not claim to add it.

The prepared directory uses the pinned upstream `@actions/tool-cache` convention:
`$RUNNER_TOOL_CACHE/sccache/<normalized-version>/<node-arch>` and its `.complete`
marker. Completed existing caches retain upstream's trust model and need no
network call for an explicit version. A stale incomplete entry fails closed with
its path for cleanup rather than mixing old and new files. The nested upstream
Node action then finds the prepared cache; its runner-managed post hook remains
registered normally. No generated vendor bundle is patched.

Upstream contract reviewed at
[`fc920bf0`](https://github.com/mozilla-actions/sccache-action/blob/fc920bf0ec8de6ee65d409111f7ec508035751ba/src/setup.ts)
and its
[`show_stats.ts`](https://github.com/mozilla-actions/sccache-action/blob/fc920bf0ec8de6ee65d409111f7ec508035751ba/src/show_stats.ts).
Review cache layout and platform mapping again when updating that pin.

## Tests

```sh
node --test actions/setup-sccache/action.test.js
bash -n actions/setup-sccache/prepare.sh actions/setup-sccache/download-release.sh
```

Tests exercise real verification, archive parsing and filesystem operations, with
network-boundary fixtures. They execute the unchanged upstream setup and post
bundles against the prepared cache, including statistics disabled/enabled. API
stall cases run real child processes with shortened test watchdog intervals.

The reusable Rust workflows embed generated copies of these helpers because their
checkout belongs to the consumer, not this action repository. Regenerate with
`node actions/setup-sccache/render.mjs`; tests run `--check` to reject drift.
`setup-rust-build` instead resolves the sibling helper through `github.action_path`.
Every call site keeps its existing upstream action pin and passes the resolved tag
through to its actual `uses` step; no unreleased self-reference is needed.
