# Cloudflare Deploy Broker

Deploy a Cloudflare Worker through the Cloudflare Deploy Broker without
Cloudflare credentials in the workflow. The
[`cloudflare-deploy-broker-build`](../../.github/workflows/cloudflare-deploy-broker-build.yml)
reusable workflow builds and attests the Worker; this action authenticates with
the job's GitHub OIDC token and asks the broker to deploy that artifact.

The deploy job must grant `id-token: write` and match a deployment policy.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `deployment-id` | Logical deployment ID | Yes | |
| `artifact-id` | `artifact-id` output of the build workflow | Yes | |
| `archive-digest` | `archive-digest` output of the build workflow | Yes | |
| `module-digest` | `module-digest` output of the build workflow | Yes | |
| `host` | Broker hostname, without a scheme, port, or path | No | `cf.tempoxyz.net` |
| `promotion` | `immediate`, or `staged` to keep the serving version at 100% and the candidate at 0% | No | `immediate` |

See [`action.yml`](action.yml) for outputs.

## Usage

Pin the workflow and the action to the same full commit SHA:

```yaml
permissions: {}

jobs:
  build:
    permissions:
      actions: write
      artifact-metadata: write
      attestations: write
      contents: read
      id-token: write
    uses: tempoxyz/gh-actions/.github/workflows/cloudflare-deploy-broker-build.yml@<commit-sha> # <tag>
    with:
      working-directory: server
      wrangler-config: wrangler.toml
      artifact-name: example-worker

  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Secure runner
        uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha> # <tag>

      - uses: tempoxyz/gh-actions/actions/cloudflare-deploy-broker@<commit-sha> # <tag>
        with:
          deployment-id: example-worker
          artifact-id: ${{ needs.build.outputs.artifact-id }}
          archive-digest: ${{ needs.build.outputs.archive-digest }}
          module-digest: ${{ needs.build.outputs.module-digest }}
```

The build installs dependencies with the lockfile in `install-directory`
(default `working-directory`): `pnpm-lock.yaml` with pnpm, `bun.lock` with
Bun, or `package-lock.json` with npm. A Bun install directory's `package.json`
must pin the exact version, as in `"packageManager": "bun@1.4.4"`. Either way
the install is frozen and Wrangler runs from the installed dependencies. npm
installs with `npm ci --ignore-scripts`, which also skips the root package's
own lifecycle scripts; run any the build needs, such as `postinstall`, from
`build-command`.

An email binding may restrict its senders with `allowed_sender_addresses`; the
build attests the sorted list as `allowedSenderAddresses`, which the deployment
policy must name exactly. Destination restrictions are rejected.

Static assets are limited to 1,000 files, 4 MiB per file, and 32 MiB total
unless the deployment policy raises them, up to 20,000 files, 25 MiB per file,
and 256 MiB total.

The build packages every module Wrangler emits. Additional ES module chunks and
`Text`, `Data` and `CompiledWasm` modules are staged under `modules/` and listed
with their types, sizes and SHA-256 digests in an attested `worker-modules.json`;
a single-module Worker emits no manifest. Each module's type comes from the
first matching Wrangler `rules` entry, then Wrangler's default rules; other
module types fail the build. Rule globs must have the form `**/*<suffix>` or
`**/<file name>`, the only forms the build can classify exactly as Wrangler
does. The main module is the file Wrangler names after `main`; the broker
uploads it as `index.js`, so an additional module that imports it by its
Wrangler name fails the build. The build allows 100 additional modules and 64 MiB
of modules in total. Deploying additional modules, a main module over 10 MiB, or
assets over the default limits requires a policy that authorizes them and a
broker release with staged artifact transfer.

## Stage a candidate before promoting it

With `promotion: staged`, an explicit policy that sets
`operations.workerVersions.stage: true` lets the release exercise the
candidate before it serves anyone. The broker uploads and verifies the candidate
as usual, then deploys `[stable@100%, candidate@0%]`. `version-id` is the
candidate and `stable-version-id` the version that keeps serving. Requests with
`Cloudflare-Workers-Version-Overrides: <worker-name>="<version-id>"` reach the
candidate. End the rollout from the same job with
[`cloudflare-deploy-broker-promote`](../cloudflare-deploy-broker-promote):

```yaml
- id: deploy
  uses: tempoxyz/gh-actions/actions/cloudflare-deploy-broker@<commit-sha> # <tag>
  with:
    deployment-id: example-worker
    artifact-id: ${{ needs.build.outputs.artifact-id }}
    archive-digest: ${{ needs.build.outputs.archive-digest }}
    module-digest: ${{ needs.build.outputs.module-digest }}
    promotion: staged

- name: Smoke test candidate
  env:
    OVERRIDE: example-worker="${{ steps.deploy.outputs.version-id }}"
  run: curl --fail --header "Cloudflare-Workers-Version-Overrides: $OVERRIDE" https://example.tempoxyz.net/health

- uses: tempoxyz/gh-actions/actions/cloudflare-deploy-broker-promote@<commit-sha> # <tag>
  with:
    deployment-id: example-worker
    operation-id: ${{ steps.deploy.outputs.operation-id }}
    action: promote

- if: ${{ failure() && steps.deploy.outputs.operation-id != '' }}
  uses: tempoxyz/gh-actions/actions/cloudflare-deploy-broker-promote@<commit-sha> # <tag>
  with:
    deployment-id: example-worker
    operation-id: ${{ steps.deploy.outputs.operation-id }}
    action: rollback
```

Staging requires a broker release with staged rollouts. Previews, policy-free
apps, first deployments and deployments that change Durable Object classes,
apply D1 migrations, own broker resources or deploy Containers always deploy
immediately; staging them fails before any change.
