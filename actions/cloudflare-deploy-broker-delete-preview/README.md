# Cloudflare Deploy Broker: delete preview

Delete a closed pull request's Cloudflare Preview through the Cloudflare Deploy
Broker, without Cloudflare credentials in the workflow. Pull requests of a
policy-free app deploy isolated previews named `pr-<number>` with the
[`cloudflare-deploy-broker`](../cloudflare-deploy-broker) action. Cloudflare
keeps each preview until it is deleted.

The broker deletes only the preview of the run's own pull request, and only from
a Worker that the repository and deployment ID own. A preview that no longer
exists is reported as `deleted: false`, so reruns succeed. The job must grant
`id-token: write`.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `deployment-id` | Logical deployment ID of the policy-free app | Yes | |
| `account-id` | Cloudflare account ID of the app's Worker | Yes | |
| `worker-name` | Name of the app's Worker | Yes | |
| `host` | Broker hostname, without a scheme, port, or path | No | `cf-deployer.tempoxyz.net` |

See [`action.yml`](action.yml) for outputs.

## Usage

Run the deploy workflow on closed pull requests too, and delete the preview
instead of deploying:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

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
```
