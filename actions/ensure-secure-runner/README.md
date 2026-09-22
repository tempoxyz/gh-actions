# Ensure secure runner

Scans every workflow under `.github/workflows` and fails unless every job runs
[`secure-runner`](../secure-runner) as its **first step**. Use it as a guard so no job
runs without Harden Runner and Socket Firewall. The check is strict by design: a job passes
only when it is `ok`, when it calls a reusable workflow (`reusable`), or when it is the job
that runs this check and nothing else (`checker`). There is no other exemption mechanism.

Workflows are parsed with [`@actions/workflow-parser`](https://www.npmjs.com/package/@actions/workflow-parser),
GitHub's own workflow parser, so job and step structure, reusable-workflow calls and `if:`
normalization match what the Actions service sees. Each job is reported as one of:

| Status | Meaning | Fails |
|--------|---------|-------|
| `ok` | The first step `uses:` an accepted action, or the job calls a workflow in this repository that is part of the same scan | |
| `reusable` | The job calls a reusable workflow that is not part of this scan; its jobs are checked where that workflow is defined | |
| `checker` | Every step of the job is `actions/checkout` or this action, so there is nothing to harden | |
| `not-a-workflow` | The file is an action manifest (`action.yml`), which is skipped; actions are called from jobs that are already checked | |
| `missing` | No step uses the action (or the job has no steps) | yes |
| `not-first` | The action is used, but not as step 1 | yes |
| `conditional` | Step 1 is the action but carries an `if:`, so it may not run | yes |
| `parse-error` | The workflow could not be parsed or validated; nothing in it can be trusted | yes |

Violations are emitted as error annotations on the offending line and listed in a table in
the step summary, which also lists the reusable-workflow calls this scan could not inspect.

## Usage

Pin this action to a full commit SHA in production (see [Versioning](../../README.md#versioning)).

```yaml
name: Ensure secure runner

on:
  push:
    branches: [main]
  pull_request:

permissions: {}

jobs:
  ensure-secure-runner:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@<commit-sha>
        with:
          persist-credentials: false

      - name: Ensure every job starts with secure-runner
        uses: tempoxyz/gh-actions/actions/ensure-secure-runner@<commit-sha>
```

The action needs only the checkout: it runs with the runner's Node and has no install step.
The job above is the one job that does not need `secure-runner` itself. It passes as
`checker` because its steps are nothing but the checkout and this action; add any other step
(a `run:`, a setup action) and it is held to the same rule as every other job.

### Reusable workflows

A job that calls a reusable workflow has no steps of its own. When the call targets a
workflow in the same repository (`uses: ./.github/workflows/x.yml`) that is included in the
scan, the job is `ok` because that workflow's jobs are checked individually. A call to a
workflow in another repository is `reusable`: it does not fail, since the called workflow's
jobs can only be inspected where it is defined, but it is listed in the step summary so the
gap is visible. Run this action in the repository that defines the workflow to cover them.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `workflows` | Workflow files or directories to check (comma, space or newline separated). Directories are not recursed, matching GitHub's discovery. Action manifests found among the paths are skipped. | No | `.github/workflows` |
| `actions` | Accepted `uses:` targets for the hardening step. An entry without `@ref` accepts any ref; an entry with one requires exactly that ref. | No | `tempoxyz/gh-actions/actions/secure-runner` |
| `fail-on-violation` | Fail the step on any violation. `false` only annotates and reports through outputs. | No | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `count` | Number of violations |
| `jobs` | Number of jobs checked |
| `workflows` | Number of workflow files checked |
| `violations` | JSON array of `{ workflow, job, line, status, detail }` |

## Maintenance

`check.mjs` holds the logic and is unit-tested by `check.test.js` (`node --test`), including a
run over this repository's own workflows. `main.mjs` wires it to the action's inputs, outputs,
annotations and step summary.

`@actions/workflow-parser` is published as ESM that imports JSON schemas without import
attributes, which plain Node refuses to load, and a composite action should not depend on a
registry install at run time. `build.mjs` therefore bundles the parser with esbuild into
`dist/workflow-parser.cjs`, which is committed; the action never runs esbuild or npm. The
output is deterministic for a given `package-lock.json`; CI rebuilds it with `--check` and
fails on drift, so a Dependabot bump of the parser must be accompanied by a rebuild:

```sh
cd actions/ensure-secure-runner
npm ci --ignore-scripts
npm audit signatures   # registry signatures and provenance attestations
npm run build
```
