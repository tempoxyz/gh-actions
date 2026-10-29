# Cloudflare Deploy Broker: delete preview

Delete a closed pull request's Cloudflare Preview through the Cloudflare Deploy
Broker, without Cloudflare credentials in the workflow. Pull requests of a
policy-free app deploy isolated previews named `pr-<number>` with the
[`cloudflare-deploy-broker`](../cloudflare-deploy-broker) action. Cloudflare
keeps each preview until it is deleted.

The broker deletes only from a Worker that the repository and deployment ID
own. A preview that no longer exists is reported as `deleted: false`, so reruns
succeed. The job must grant `id-token: write`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `deployment-id` | Logical deployment ID of the policy-free app | Yes | |
| `account-id` | Cloudflare account ID of the app's Worker | Yes | |
| `worker-name` | Name of the app's Worker | Yes | |
| `preview-name` | `pr-<number>` to delete; required for merged pull requests | No | |
| `host` | Broker hostname, without a scheme, port, or path | No | `cf-deployer.tempoxyz.net` |

See [`action.yml`](action.yml) for outputs.

## Usage

Run the deploy workflow on closed pull requests too, and delete the preview
instead of deploying:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

# One run per pull request (or other ref) and workflow at a time, never
# cancelled: the broker completes work a cancelled job started, so an
# overlapping deploy could recreate a deleted preview, or a cleanup delete a
# reopened one. A newer pending run still replaces an older pending one.
concurrency:
  group: ${{ github.workflow }}-preview-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false

jobs:
  # Gate the build and deploy jobs with:
  #   if: github.event.action != 'closed'
  delete-preview:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - name: Secure runner
        uses: tempoxyz/gh-actions/actions/secure-runner@<commit-sha> # <tag>

      - uses: tempoxyz/gh-actions/actions/cloudflare-deploy-broker-delete-preview@<commit-sha> # <tag>
        with:
          deployment-id: example-worker
          account-id: 0123456789abcdef0123456789abcdef
          worker-name: example-worker
          preview-name: pr-${{ github.event.pull_request.number }}
```

GitHub runs a merged pull request's closing workflow on the branch it was
merged into, so that run's identity is `main` and carries no pull request
number: pass `preview-name`. An unmerged pull request's run may delete only its
own preview, whatever it names.
