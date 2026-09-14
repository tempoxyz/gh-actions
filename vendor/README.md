# vendor/

Copies of third-party GitHub Actions, one directory per upstream repository
(`vendor/<owner>/<repo>/`), generated from [`../vendor-manifest.yml`](../vendor-manifest.yml).
Consumers reference them as `tempoxyz/gh-actions/vendor/<owner>/<repo>[/<path>]@<sha>`; the
table of what is vendored lives in the [root README](../README.md#3rd-party-actions).

Never edit a vendored tree by hand. Change the manifest and re-run the sync; CI rebuilds every
tree from the manifest and fails on any difference.

## Commands

| Command | What it does |
|---------|--------------|
| `node vendor/add.mjs <owner/repo>@<tag\|sha> [--label v1.2.3] [--path <sub>] [--with-deps]` | Resolve the ref, analyze what the action loads at run time, append a manifest entry with `exclude`/`keep`/`notes`, vendor it, refresh the README table. `--with-deps` also vendors nested third-party actions at the commit the composite pins. `--path` names a sub-directory action that is used (repeatable). `--dry-run` prints the entry only. |
| `node vendor/add.mjs --refresh <owner/repo>` | Re-run the analysis for an existing entry at its current commit (after the tooling changes or upstream restructures). Keeps `ref`, `sha`, `pin_nested`, sub-path keeps and manual notes. |
| `node vendor/sync.mjs [names...]` | Rebuild trees from the manifest and refresh the README table. |
| `node vendor/sync.mjs --check` | CI: rebuild into a temp dir and fail on drift in `vendor/` or the README table. |
| `node vendor/update.mjs [--json] [--min-age-days 7]` | List newer upstream versions (same major for semver tags, tip for branches and moving tags), skipping commits younger than the cooldown. |
| `node vendor/update.mjs --apply <name>...` | Bump `ref`/`sha`, resolve any new nested pins, re-sync. Used by `.github/workflows/vendor-update.yml`, run manually (optionally for a single action), which opens one PR per updated action. |
| `node --test vendor/lib.test.js` | Unit tests for glob matching, `uses:` rewriting, README rendering. |

Requirements: Node 20+, git, tar, `yq` (GitHub-hosted runners ship all four; locally `brew install yq`).

## What the sync does per entry

1. **Resolve and verify.** `git ls-remote` the upstream. If the manifest `ref` is a tag and it no longer
   points at the pinned `sha`, abort: a moved tag is the signature of every 2025 to 2026 action
   compromise and needs a human before anything is copied.
2. **Fetch exactly the pinned commit** (`git fetch --depth 1 <url> <sha>`, then `git archive`).
   File modes are preserved, so Docker entrypoints and shell scripts stay executable.
3. **Apply excludes.** Repo-wide `default_exclude` (docs, images, upstream CI, VCS and editor
   metadata, source maps) plus the entry's own `exclude`, minus `keep`. `action.yml`, `package.json`
   and `LICENSE*` are always kept, as are `.github/*.json` files (problem matchers and release manifests that actions load at run time).
4. **Rewrite nested `uses:`.** Third-party references inside composite actions become
   `$/vendor/<owner>/<repo>`, which resolves to this repository at the commit the caller pinned
   (runner 2.336.0 or newer). References to `actions/*` and `github/*` stay and, if upstream pinned
   them by tag, are pinned to the commit recorded in `pin_nested` so the org's SHA-pinning policy holds.
   A nested reference that is neither vendored nor allowed fails the sync.
5. **Stamp `.vendored.json`** with upstream URL, ref, sha, upstream commit date, README link and
   description (used for the README table). No wall-clock values, so re-runs are byte-identical.

## How the analysis decides what to exclude

The analyzer reads `action.yml` (and any `--path` sub-actions) and works out the load set:

- **Node actions**: the `main`/`pre`/`post` files and their directories. Entry files are scanned
  for relative paths that escape their directory (`../x`, `__dirname` joins) and, when the file is
  not a self-contained bundle, for bare imports that need a committed `node_modules/`. Sibling
  bundle directories nobody references (`dist/<other-action>/`) are dropped.
- **Composite actions**: every string in every step is scanned for `${{ github.action_path }}/<p>`
  and `$GITHUB_ACTION_PATH/<p>`; referenced scripts are scanned one level deeper. A step that uses
  the action directory itself (as a working directory, `PYTHONPATH`, or through `dirname "$0"`)
  makes the load set undeterminable.
- **Docker actions**: `Dockerfile` `COPY`/`ADD` sources. `COPY . .` makes it undeterminable.
  Actions that run a prebuilt `docker://` image load nothing from the repo.

Everything at the top level that is not in the load set is excluded and listed in the entry. When
the load set cannot be determined the entry says so in `notes`, keeps the whole repository apart
from `default_exclude`, and `exclude` is empty. Manual tightening is welcome when a human has
read the scripts: prefix the sentence with `Manual:` in `notes` so `--refresh` preserves it.
