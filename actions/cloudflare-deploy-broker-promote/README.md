# Cloudflare Deploy Broker: promote

Promote or roll back a staged Worker rollout through the Cloudflare Deploy
Broker, without Cloudflare credentials in the workflow. The
[`cloudflare-deploy-broker`](../cloudflare-deploy-broker) action stages a
candidate with `promotion: staged`: the serving version keeps 100% and the
candidate gets 0%, reachable only through `Cloudflare-Workers-Version-Overrides`.

| `action` | Result |
|----------|--------|
| `promote` | The candidate serves 100%; the broker then reconciles and verifies logpush, observability, schedules, Queue consumers and Workflows |
| `rollback` | The version that served when the rollout was staged serves 100% again, before or after promotion |

- Only the workflow run attempt that staged the rollout may end it. The job
  must grant `id-token: write`.
- Both actions are idempotent: `changed: false` reports that a retry found the
  state already live.
- Promotion requires the unchanged policy that authorized the upload. Rollback
  stays available after a policy change.
- Either action fails with `rollout_diverged` when anything else deployed the
  Worker after staging, such as a dashboard secret change. Start a new
  deployment.
- Rollback restores only the version; script-level settings that promotion
  applied stay as they are.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `deployment-id` | Logical deployment ID that staged the rollout | Yes | |
| `operation-id` | `operation-id` output of the staging deploy step | Yes | |
| `action` | `promote` or `rollback` | Yes | |
| `host` | Broker hostname, without a scheme, port, or path | No | `cf.tempoxyz.net` |

## Outputs

| Name | Description |
|------|-------------|
| `state` | `promoted` or `rolled_back` |
| `version-id` | Version now serving 100% of requests |
| `deployment-id` | Cloudflare deployment now active |
| `stable-version-id` | Version that served when the rollout was staged |
| `candidate-version-id` | Staged candidate |
| `changed` | `false` when the requested state was already live |
| `operation-id` | Operation that staged the rollout |

## Usage

See [Stage a candidate before promoting it](../cloudflare-deploy-broker/README.md#stage-a-candidate-before-promoting-it).
