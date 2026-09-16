# OSV Scanner

Tempo-owned action for native OSV dependency scans and PR vulnerability comparisons
on Linux, macOS, and Windows. It installs OSV Scanner v2.6.0 for the runner's OS and
architecture (x64 or ARM64). Node.js 20+ is required; Docker and Go are not required.

Prefer the [Dependency Scan workflow](../../.github/workflows/dependency-scan.yml).
The design follows Google's [PR workflow](https://github.com/google/osv-scanner-action/blob/8ac9e5ce44cc7178e0e04229a91bdcc003166e57/.github/workflows/osv-scanner-reusable-pr.yml).
Google does not publish cross-platform reporter binaries, so comparison and report
generation run in Node.js. The comparison follows upstream's occurrence-count gate
and then its source/package/advisory diff: an unchanged vulnerability or a moved
lockfile alone is baselined; an added vulnerable occurrence is reported.

## Binary verification

`releases.json` pins SHA-256 hashes for every platform's scanner, SLSA verifier,
and provenance files. The verifier is bootstrapped from its pinned digest, then
verifies its own SLSA provenance. The scanner must pass both its pinned checksum
and SLSA verification for `github.com/google/osv-scanner` at the exact release tag
before execution. Failed verification stops the action. Cached downloads under
`runner.temp` are rechecked on every scan invocation.

Runner policy must allow GitHub release downloads, Sigstore verification, OSV API
access, and any package metadata endpoints the selected scanners use. No GitHub
or OIDC credentials or process-injection environment variables are forwarded to
the native child processes. Call analysis is disabled, so Rust build scripts are
not run. Scans run directly on the runner, with its filesystem permissions; there
is no container or read-only mount. Scanner configuration and ignore rules apply.

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `scan` | `scan` writes JSON; `report` compares old/new JSON |
| `scan-args` | `--recursive` then `./` | One argument per line, including paths with spaces; no shell expansion. Format/output/call-analysis flags are managed internally |
| `results-directory` | required | Existing absolute directory under `runner.temp`, outside the checkout |
| `results-file` | `results.json` | Simple JSON filename for scan mode |
| `fail-on-vuln` | `true` | Fail report mode on new vulnerabilities; false still fails on operational errors |

Scan mode returns success for completed scans, including vulnerable dependencies,
so the reporter can compare them. Empty dependency inventories are allowed and must
still produce valid JSON. Operational failures, missing results, and invalid JSON
always fail. The `vulnerabilities-found` output indicates findings in either mode.

Report mode requires `old-results.json` and `new-results.json`. It writes `diff.json`,
`results.sarif`, and `summary.md`, prints annotations and a Markdown report, and
appends it to the job summary. Artifact locations are normalized for both Windows
and POSIX paths. It does not upload to GitHub Code Scanning.

License checks, Scorecard results, and dependency-review-action's inputs/outputs
are not provided by this action.

## Tests and updates

Run `node --test actions/osv-scanner-action/*.test.js` for unit tests and
`node actions/osv-scanner-action/integration.mjs` for verified native installation
and real scans. The integration test requires network access. CI runs both on
`ubuntu-latest`, `macos-latest`, and `windows-latest`, including paths with spaces,
clean/introduced/unchanged/removed findings, empty inventories, malformed lockfiles,
warning-only behavior, report artifacts, a wrong provenance identity, and a corrupt
cached binary. The reusable workflow is also exercised on all three platforms.

When updating OSV or the verifier, update the versions and hashes in `releases.json`,
run all platform tests, and update the workflow's pinned action revision.
