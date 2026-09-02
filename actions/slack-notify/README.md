# Slack notify

POST a JSON payload to a Slack Web API method (bot token) or an incoming webhook. A `curl`;
replaces `slackapi/slack-github-action` for the `method` + `token` + `payload` usage.

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `token` | Bot token (`xoxb-...`); required unless `webhook` is set | No | `""` |
| `webhook` | Incoming webhook URL | No | `""` |
| `method` | Web API method | No | `chat.postMessage` |
| `payload` | JSON payload | Yes | |

## Usage

```yaml
- uses: tempoxyz/gh-actions/actions/slack-notify@main
  with:
    token: ${{ secrets.SLACK_BOT_TOKEN }}
    payload: |
      {"channel": "#ops", "text": "Deploy finished: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}
```

The step fails when Slack returns `ok: false`, with the API's `error` in the message.
