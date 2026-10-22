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
| `host` | Broker hostname, without a scheme, port, or path | No | `cf-deployer.tempoxyz.net` |

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
