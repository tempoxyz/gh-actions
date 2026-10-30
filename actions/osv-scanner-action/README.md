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
and provenance files. At runtime the action downloads only the scanner for the
runner's platform and refuses to run it unless it matches its pinned digest.
Cached downloads under `runner.temp` are rechecked on every scan invocation.

SLSA provenance is verified in this repository's CI rather than in every scan:
the [OSV Provenance workflow](../../.github/workflows/osv-scanner-provenance.yml)
runs `provenance.mjs` on every change to this action. It bootstraps the verifier
from its pinned digest, verifies the verifier's own provenance, then verifies every
pinned scanner and verifier binary for all six platforms against
`github.com/google/osv-scanner` and `github.com/slsa-framework/slsa-verifier`
at their exact release tags, and checks that a wrong source identity is rejected.
Since the digests and this code ship in the same reviewed commit, scans get the
same guarantee without depending on Sigstore's transparency log (Rekor) being
reachable, which used to fail scans on timeouts.

Runner policy must allow GitHub release downloads, OSV API access, and any package
metadata endpoints the selected scanners use; Sigstore access is needed only for
the provenance workflow. No GitHub or OIDC credentials or process-injection
environment variables are forwarded to the native child processes. Call analysis
is disabled, so Rust build scripts are not run. Scans run directly on the runner,
with its filesystem permissions; there is no container or read-only mount. Scanner
configuration and ignore rules apply.

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

Run `node --test actions/osv-scanner-action/*.test.js` for unit tests,
`node actions/osv-scanner-action/integration.mjs` for checksum-verified native
installation and real scans, and `node actions/osv-scanner-action/provenance.mjs`
for SLSA provenance of every pinned binary. The integration test requires network access. CI runs both on
`ubuntu-latest`, `macos-latest`, and `windows-latest`, including paths with spaces,
clean/introduced/unchanged/removed findings, empty inventories, malformed lockfiles,
warning-only behavior, report artifacts, and a corrupt cached binary. The reusable workflow is also exercised on all three platforms.

When updating OSV or the verifier, update the versions and hashes in `releases.json`;
make sure the OSV Provenance workflow passes before merging, run all platform tests,
and update the workflow's pinned action revision.
