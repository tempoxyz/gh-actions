# OSV Scanner

Tempo-owned composite action for OSV source scans and PR vulnerability comparisons.
Uses the same OSV Scanner and reporter image as Google's
[scanner action](https://github.com/google/osv-scanner-action/blob/8ac9e5ce44cc7178e0e04229a91bdcc003166e57/osv-scanner-action/action.yml)
and [PR workflow](https://github.com/google/osv-scanner-action/blob/8ac9e5ce44cc7178e0e04229a91bdcc003166e57/.github/workflows/osv-scanner-reusable-pr.yml),
pinned to the v2.6.0 multi-architecture image digest. No Google-owned action is invoked.
The container is downloaded from `ghcr.io/google/osv-scanner-action`; it is not hosted
in the Tempo registry. Docker image pulls and OSV API access must be allowed by runner policy.

Prefer the [Dependency Vulnerability Scan workflow](../../.github/workflows/dependency-vulnerability-scan.yml).
This action requires a Linux runner with Docker and Node.js. The source workspace is
mounted read-only, results are mounted separately, and GitHub/OIDC credentials are
not passed to the container. Call analysis is disabled, so the scan does not run
Rust build scripts. Scanner configuration files and ignore rules still apply.

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
`results.sarif`, and `summary.md`, prints annotations and a table, and appends the
Markdown report to the job summary. It does not upload to GitHub Code Scanning.

The reporter follows upstream's vulnerability comparison semantics, not a raw
package diff: existing findings are baselined, and new findings fail by default.
License checks, Scorecard results, and dependency-review-action's inputs/outputs
are not provided by this action.

Run wrapper regression tests with `node --test actions/osv-scanner-action/run.test.js`.
When updating OSV, update `IMAGE` in `run.mjs`, verify the registry digest, and test
clean, vulnerable, unchanged, removed, empty, and failed scan comparisons with the
real image before changing the workflow's pinned action revision.
