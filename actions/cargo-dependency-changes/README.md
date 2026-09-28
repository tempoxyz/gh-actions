# Cargo dependency changes

Reads changed Cargo manifests and lockfiles through GitHub's API and compares the
versions and sources of dependencies matching a package prefix. No checkout or
execution of the candidate repository is needed. Requires Python 3.11+ and `gh`
(on GitHub's Ubuntu runners).

```yaml
- uses: tempoxyz/gh-actions/actions/cargo-dependency-changes@<commit>
  id: reth
  with:
    package-prefix: reth
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
```

`changed` is `true` for dependency additions, removals, version/source changes and
possibly truncated comparisons (300 files). Reth matches `reth` and `reth-*`,
including aliased packages, target-specific dependencies and patches. Comments,
formatting, feature-only edits and unrelated dependencies do not trigger a run.
API, decoding and TOML errors fail the action; they never produce a false skip.
The comparison uses the merge base so it covers the full PR diff.

Run tests with `python3 -m unittest discover -s actions/cargo-dependency-changes -v`.
