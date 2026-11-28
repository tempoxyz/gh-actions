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
`build-command`. `npm ci` deletes `node_modules` before installing, so an npm
build rejects `build-cache-paths` under `node_modules`.

An email binding may restrict its senders with `allowed_sender_addresses`; the
build attests the sorted list as `allowedSenderAddresses`, which the deployment
policy must name exactly. Destination restrictions are rejected.

Static assets are limited to 1,000 files, 4 MiB per file, and 32 MiB total
unless the deployment policy raises them, up to 20,000 files, 25 MiB per file,
and 1 GiB total; a policy that allows more than 256 MiB needs a broker release
whose staged archives may reach 1.25 GiB. Each asset's Content-Type comes from
its extension, such as `video/mp4`, `application/pdf` or `model/gltf-binary`;
an asset with an extension the build does not list is served without one.

With `lfs: true`, the build fetches the commit's Git LFS objects right after
checkout with the job's read-only `github.token`. git-lfs checks each object
against the SHA-256 recorded in the commit, so the provenance still pins the
content. `lfs-exclude` lists repository-relative paths or globs whose objects
are not fetched, such as videos a separate job uploads to R2:

```yaml
    with:
      lfs: true
      lfs-exclude: |
        public/videos/**
        *.mp4
```

Every other LFS file must be fetched, or the build fails; `.lfsconfig` cannot
narrow the fetch. Excluded files stay LFS pointers, and a static asset that is
a pointer fails the build whether or not `lfs` is set, so keep excluded files
out of the asset directory, for example by deleting them in `build-command`.
LFS files in submodules are not fetched.

The build packages every module Wrangler emits. Additional ES module chunks and
`Text`, `Data` and `CompiledWasm` modules are staged under `modules/` and listed
with their types, sizes and SHA-256 digests in an attested `worker-modules.json`;
a single-module Worker emits no manifest. Each module's type comes from the
first matching Wrangler `rules` entry, then Wrangler's default rules; other
module types fail the build. Rule globs must have the form `**/*<suffix>` or
`**/<file name>`, the only forms the build can classify exactly as Wrangler
does. The main module is the file Wrangler names after `main`; the broker
uploads it as `index.js`, so an additional module that imports it by its
Wrangler name fails the build. The build allows 1,000 additional modules and 64 MiB
of modules in total. Deploying additional modules, a main module over 10 MiB, or
assets over the default limits requires a policy that authorizes them and a
broker release with staged artifact transfer.

The build job times out after 15 minutes. Set `timeout-minutes`, up to 120,
for a slower build.

## Check a configuration without deploying it

With `check-only: true`, the build installs, builds and runs every check a
deploying build runs, then stops. It attests nothing and uploads no Worker
artifact, so there is nothing to deploy. Use it on pull requests for a Wrangler
configuration that deploys only from the default branch, such as production;
otherwise an option the build rejects shows up only when that deploy fails. Pin
it to the same commit as the deploying build so both apply the same checks:

```yaml
  check-production:
    permissions:
      actions: write
      artifact-metadata: write
      attestations: write
      contents: read
      id-token: write
    uses: tempoxyz/gh-actions/.github/workflows/cloudflare-deploy-broker-build.yml@<commit-sha> # <tag>
    with:
      working-directory: server
      wrangler-config: wrangler.prd.toml
      check-only: true
```

Pass the same inputs as the deploying build. With `publish-container-image`,
a check runs every Container check, including the instance type, the instance
cap and the Dockerfile and build context paths. It doesn't log in to Docker
Hub, build the image or push it. With `unattested-artifact-directory`, a check
fails if the directory has no file the deploying build would upload.

The caller still grants the build job's permissions, because GitHub requires
them before the job starts. The digest outputs, such as
`worker-configuration-digest`, are set as in a deploying build, except that a
Container Worker's configuration names no image. `artifact-id`,
`archive-digest`, `container-image-digest` and `unattested-artifact-id` are
empty.

## Containers

With `publish-container-image: true` and a `dockerhub-oidc-connection-id`, the
build pushes the Wrangler configuration's one Container image to the private
`docker.io/tempoxyz/<container name>` repository and attests its digest. The
broker then creates or updates the Cloudflare Container application, which an
explicit policy must authorize with the same name, class, repository, instance
type and instance cap:

```toml
[[containers]]
name = "example-container"
class_name = "ExampleContainer"
image = "./Dockerfile"
instance_type = "standard-3"
max_instances = 20
```

- `instance_type` must be explicit and one of `lite`, `basic`, `standard-1`,
  `standard-2`, `standard-3` or `standard-4`. Custom instance shapes and the
  deprecated `dev` and `standard` names fail the build.
- `max_instances` must be an explicit integer from 1 to 100. The deprecated
  `instances` fails the build.
- The build applies `image_build_context` and `image_vars` (as build
  arguments). Every other Container setting, such as `scheduling_policy`,
  `constraints`, `ssh`, `observability` or the `rollout_*` settings, fails the
  build: the broker would not apply it. The broker rolls out a new image to
  every instance in one step.
- The Dockerfile and build context must be inside `working-directory`. The
  image is built for `linux/amd64`, without build secrets.
- Brokers older than
  [tempoxyz/cloudflare-deploy-broker#292](https://github.com/tempoxyz/cloudflare-deploy-broker/pull/292)
  accept only `lite` with `max_instances = 1`.

The Docker Hub token lasts as long as the job may, at least five minutes, so a
long image build can still push. Image builds have no layer cache: raise
`timeout-minutes` for an image that compiles from source.

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
