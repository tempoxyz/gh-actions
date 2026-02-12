# Publish Event

POST a webhook event to notify downstream systems.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `url` | Webhook URL (can include auth args via secrets) | Yes | |
| `event-type` | Event type identifier | Yes | `registry_package` |
| `tag` | Image tag or version to include in payload | Yes | |
| `repository` | Repository name (defaults to `github.repository`) | No | `""` |
| `extra-data` | Additional JSON data to merge into the data object | No | `""` |
| `retries` | Number of retries on failure | No | `3` |

## Usage

```yaml
steps:
  - uses: tempoxyz/gh-actions/actions/publish-event@main
    with:
      url: ${{ secrets.WEBHOOK_URL }}
      event-type: registry_package
      tag: ${{ github.ref_name }}

  - uses: tempoxyz/gh-actions/actions/publish-event@main
    with:
      url: ${{ secrets.WEBHOOK_URL }}
      event-type: deploy
      tag: v1.0.0
      extra-data: '{"environment": "production"}'
```
