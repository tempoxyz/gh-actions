# SITF organization audit

Read-only GitHub organization and repository audit mapped to the [Wiz SDLC Infrastructure Threat Framework (SITF)](https://github.com/wiz-sec-public/SITF). It produces a Markdown report for people and a JSON report for automation.

The audit enumerates every repository visible to the supplied token, including archived repositories and forks by default. For each current default branch it checks observable VCS, CI/CD, registry, endpoint/dependency, and deployment risks. API failures and inaccessible settings are reported as limitations rather than interpreted as secure or insecure.

To stay within GitHub's API budget on large organizations, public workflow files are read from GitHub's raw-content service; private workflow files use the authenticated Git data API.

## Usage

```yaml
name: SITF organization audit

on:
  workflow_dispatch:
  schedule:
    - cron: "17 9 * * 1"

permissions: {}

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<commit-sha> # v4
        with:
          persist-credentials: false
      - uses: tempoxyz/gh-actions/actions/sitf-org-audit@<commit-sha> # main
        with:
          targets: |
            tempoxyz
            paradigmxyz/reth
            alloy-rs
          token: ${{ secrets.SITF_GITHUB_TOKEN }}
          fail-on: none
      - uses: actions/upload-artifact@<commit-sha> # v4
        with:
          name: sitf-audit
          path: sitf-audit/
```

Use a fine-grained PAT or GitHub App token with read access to all target repositories, repository metadata/settings, organization administration settings, and Actions settings. The job's `GITHUB_TOKEN` is scoped to its caller repository and cannot exhaustively inspect other private repositories or organizations.

## Inputs

| Name | Description | Default |
|---|---|---|
| `targets` | Comma or newline-separated organizations and `owner/repository` targets | required |
| `token` | GitHub token with read access to every target and its settings | required |
| `output-directory` | Report directory | `sitf-audit` |
| `include-archived` | Include archived repositories | `true` |
| `include-forks` | Include forks | `true` |
| `fail-on` | Exit nonzero at `critical`, `high`, `medium`, or `low`; `none` only reports | `none` |

## Outputs

The action returns `markdown`, `json`, `findings`, and `failed-repositories`. Findings contain repository, severity, SITF component and technique IDs, evidence, and remediation.

## Scope and interpretation

The scanner reads only current default branches and GitHub's current settings APIs. It does not inspect other branches, history, pull requests, cloud accounts, registry ACLs, endpoint controls, identity-provider policies, runtime behavior, or runner hosts. Findings identify attack-enabling conditions to review; they do not prove a vulnerability or compromise.

SITF is maintained by Wiz and licensed separately. This action links and maps to its public technique identifiers but does not redistribute the framework dataset.
