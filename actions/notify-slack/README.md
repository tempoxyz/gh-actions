# Notify Slack

Post a Slack message through [slack-notifier](https://github.com/tempoxyz/slack-notifier)
with no Slack token. The step requests the job's GitHub OIDC token for
`slack-notifier.tempoxyz.net` and sends it with the message. The service
checks the token against its sender policies and posts the message as that
policy's sender, with the policy's name and icon. No token is returned to the
job.

The job needs `id-token: write`, and the repository needs a sender policy in
slack-notifier that admits the job: a file in `policies/<repository>-<repository ID>/`
(see its [policies/README.md](https://github.com/tempoxyz/slack-notifier/blob/main/policies/README.md)).

## Inputs

The message arguments of Slack's
[`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage).
The sender (`username`, `icon_url`, `icon_emoji`) is not an input: the policy
sets it.

| Name              | Description                                                                                          | Required |
| ----------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| `channel`         | Conversation ID (`C…`, `G…`, `D…`), a person's member ID (`U…`, `W…`) to DM them, or `#channel-name` | Yes      |
| `text`            | Message text (mrkdwn). With `blocks` or `attachments`, the notification fallback.                    | \*       |
| `blocks`          | Block Kit blocks, as a JSON array                                                                    | \*       |
| `attachments`     | Legacy attachments, as a JSON array                                                                  | \*       |
| `thread_ts`       | `ts` of the message to reply to                                                                      | No       |
| `reply_broadcast` | `true` to also show a thread reply in the channel                                                    | No       |
| `unfurl_links`    | `true` to unfurl text-based links                                                                    | No       |
| `unfurl_media`    | `false` to stop unfurling images and video                                                           | No       |
| `mrkdwn`          | `false` to post `text` without formatting                                                            | No       |
| `parse`           | `none` or `full`                                                                                     | No       |
| `link_names`      | `true` to link `@names` and `#channels` in `text`                                                    | No       |
| `metadata`        | `{"event_type": "...", "event_payload": {...}}`                                                      | No       |
| `policy`          | The slack-notifier policy to post under; needed only when several of the repository's policies admit the job | No |

\* At least one of `text`, `blocks` and `attachments`.

Any public channel works without inviting the app. A private channel needs the
app invited first (`/invite @Tempo Notifier`). A member ID (Slack profile → ⋮ →
Copy member ID) sends a DM from the app.

## Outputs

| Name      | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| `ts`      | The message's timestamp, for `thread_ts`                                     |
| `channel` | The conversation it went to. For a DM, its `D…` ID, which `thread_ts` replies need. |

## Usage

Pin the action to a full commit SHA:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Announce the deploy
    id: announce
    uses: tempoxyz/gh-actions/actions/notify-slack@<commit-sha>
    with:
      channel: C0123456789
      text: "Deploying ${{ github.sha }}: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
      unfurl_links: false

  - name: Reply in the thread
    uses: tempoxyz/gh-actions/actions/notify-slack@<commit-sha>
    with:
      channel: ${{ steps.announce.outputs.channel }}
      thread_ts: ${{ steps.announce.outputs.ts }}
      text: Done.
```

Block Kit:

```yaml
- uses: tempoxyz/gh-actions/actions/notify-slack@<commit-sha>
  with:
    channel: "#deploys"
    text: Deploy finished
    blocks: |
      [{"type": "section", "text": {"type": "mrkdwn", "text": "*Deploy finished* :white_check_mark:"}}]
```

## Failures and retries

The step fails with slack-notifier's reason: an unknown channel, no policy
admitting the job, a malformed message, and so on. It retries, with a new OIDC
token each time, only when nothing was posted: no answer, HTTP 503, or HTTP
429 (Slack's rate limit, waiting its `Retry-After` up to 60 seconds). It makes
at most three attempts.

## Tests

```sh
node --test actions/notify-slack/action.test.js
```

The tests run the script against stand-ins for `curl` and `sleep`.
