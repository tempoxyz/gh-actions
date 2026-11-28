#!/usr/bin/env bash
# Post one Slack message through slack-notifier (tempoxyz/slack-notifier).
# The job's GitHub OIDC token, with slack-notifier's hostname as its
# audience, is the only credential: the service checks it against its sender
# policies and posts as the policy's sender. No Slack token reaches the job,
# and none is returned.
#
# Inputs arrive as NOTIFY_* environment variables (action.yml).
set -euo pipefail

HOST="slack-notifier.tempoxyz.net"
MAX_ATTEMPTS=3
MAX_RETRY_AFTER_SECONDS=60

fail() {
  echo "::error title=notify-slack::$*"
  exit 1
}

# --- Inputs --------------------------------------------------------------

[[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] ||
  fail "the job needs \`permissions: id-token: write\`"

channel="${NOTIFY_CHANNEL:-}"
[[ "$channel" =~ ^([CGDUW][A-Z0-9]{2,31}|#[a-z0-9][a-z0-9._-]{0,79})$ ]] ||
  fail "channel must be a conversation ID (C…, G…, D…), a member ID (U…, W…) or #channel-name"

policy="${NOTIFY_POLICY:-}"
if [[ -n "$policy" ]] && { [[ ! "$policy" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || [[ "$policy" == "." || "$policy" == ".." ]]; }; then
  fail "policy must be 1-64 letters, digits, dots, underscores or hyphens"
fi

json_input() { # name value jq-type
  [[ -z "$2" ]] && return 0
  jq -e --arg type "$3" 'type == $type' >/dev/null 2>&1 <<<"$2" || fail "$1 must be a JSON $3"
}
json_input blocks "${NOTIFY_BLOCKS:-}" array
json_input attachments "${NOTIFY_ATTACHMENTS:-}" array
json_input metadata "${NOTIFY_METADATA:-}" object

boolean_input() { # name value
  [[ "$2" =~ ^(true|false)?$ ]] || fail "$1 must be true or false"
}
boolean_input reply_broadcast "${NOTIFY_REPLY_BROADCAST:-}"
boolean_input unfurl_links "${NOTIFY_UNFURL_LINKS:-}"
boolean_input unfurl_media "${NOTIFY_UNFURL_MEDIA:-}"
boolean_input mrkdwn "${NOTIFY_MRKDWN:-}"
boolean_input link_names "${NOTIFY_LINK_NAMES:-}"
[[ "${NOTIFY_PARSE:-}" =~ ^(none|full)?$ ]] || fail "parse must be none or full"
[[ "${NOTIFY_THREAD_TS:-}" =~ ^([0-9]{1,12}\.[0-9]{1,9})?$ ]] ||
  fail "thread_ts must be a message timestamp such as 1700000000.123456"
[[ -n "${NOTIFY_TEXT:-}${NOTIFY_BLOCKS:-}${NOTIFY_ATTACHMENTS:-}" ]] ||
  fail "one of text, blocks or attachments is required"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/notify-slack-XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Only the arguments that were given, with their JSON types.
jq -n \
  --arg channel "$channel" \
  --arg text "${NOTIFY_TEXT:-}" \
  --arg blocks "${NOTIFY_BLOCKS:-}" \
  --arg attachments "${NOTIFY_ATTACHMENTS:-}" \
  --arg metadata "${NOTIFY_METADATA:-}" \
  --arg thread_ts "${NOTIFY_THREAD_TS:-}" \
  --arg parse "${NOTIFY_PARSE:-}" \
  --arg reply_broadcast "${NOTIFY_REPLY_BROADCAST:-}" \
  --arg unfurl_links "${NOTIFY_UNFURL_LINKS:-}" \
  --arg unfurl_media "${NOTIFY_UNFURL_MEDIA:-}" \
  --arg mrkdwn "${NOTIFY_MRKDWN:-}" \
  --arg link_names "${NOTIFY_LINK_NAMES:-}" '
  def str($k; $v): if $v == "" then {} else {($k): $v} end;
  def json($k; $v): if $v == "" then {} else {($k): ($v | fromjson)} end;
  def bool($k; $v): if $v == "" then {} else {($k): ($v == "true")} end;
  {channel: $channel}
  + str("text"; $text) + json("blocks"; $blocks) + json("attachments"; $attachments)
  + str("thread_ts"; $thread_ts) + bool("reply_broadcast"; $reply_broadcast)
  + bool("unfurl_links"; $unfurl_links) + bool("unfurl_media"; $unfurl_media)
  + bool("mrkdwn"; $mrkdwn) + str("parse"; $parse) + bool("link_names"; $link_names)
  + json("metadata"; $metadata)' >"$work/body.json"

url="https://${HOST}/v1/messages"
[[ -n "$policy" ]] && url="${url}?policy=${policy}"

# --- Send ----------------------------------------------------------------

# A fresh OIDC token for each attempt, so a retry never outlives its token.
# Sets `token`; not run in a subshell, so `fail` ends the step.
fetch_oidc_token() {
  local response
  token=""
  response="$(curl -fsS --max-time 15 --retry 3 --retry-connrefused \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${HOST}")" || fail "could not get a GitHub OIDC token"
  token="$(jq -r '.value // empty' <<<"$response" 2>/dev/null)" || token=""
  [[ "$token" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]] ||
    fail "GitHub returned no OIDC token"
  echo "::add-mask::${token}"
}

# One field of the JSON response, with control characters removed, or empty.
field() { # name max-length
  jq -r --arg name "$1" --argjson max "$2" \
    '(.[$name] // "") | tostring | gsub("[[:cntrl:]]+"; " ") | .[0:$max]' \
    "$work/response.json" 2>/dev/null || true
}

attempt=1
while :; do
  fetch_oidc_token
  : >"$work/response.json"
  : >"$work/headers.txt"
  status="$(curl -sS --max-time 30 -o "$work/response.json" -D "$work/headers.txt" -w '%{http_code}' \
    -X POST "$url" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -H "User-Agent: tempoxyz-notify-slack-action" \
    --data-binary "@$work/body.json")" || status="000"

  if [[ "$status" == 200 ]]; then
    posted_channel="$(field channel 32)"
    ts="$(field ts 32)"
    [[ "$posted_channel" =~ ^[CGD][A-Z0-9]{2,31}$ && "$ts" =~ ^[0-9]{1,12}\.[0-9]{1,9}$ ]] ||
      fail "slack-notifier answered without a message"
    {
      echo "channel=${posted_channel}"
      echo "ts=${ts}"
    } >>"$GITHUB_OUTPUT"
    echo "Posted to ${posted_channel} as \"$(field username 80)\" (ts ${ts})."
    exit 0
  fi

  error="$(field error 500)"
  # Retry only when nothing was posted: no answer, Slack's rate limit, or the
  # service unavailable. Every other answer is final.
  if [[ "$status" =~ ^(000|429|503)$ ]] && ((attempt < MAX_ATTEMPTS)); then
    wait=$((2 ** attempt))
    retry_after="$(tr -d '\r' <"$work/headers.txt" |
      awk -F': *' 'tolower($1) == "retry-after" { print $2 }' | tail -n 1)"
    if [[ "$retry_after" =~ ^[0-9]+$ ]] && ((retry_after > wait)); then
      ((retry_after <= MAX_RETRY_AFTER_SECONDS)) ||
        fail "Slack rate limited the message (retry after ${retry_after}s)"
      wait="$retry_after"
    fi
    echo "slack-notifier answered HTTP ${status}${error:+: ${error}}; retrying in ${wait}s (attempt $((attempt + 1))/${MAX_ATTEMPTS})."
    sleep "$wait"
    attempt=$((attempt + 1))
    continue
  fi
  [[ "$status" == 000 ]] && fail "could not reach ${HOST}"
  fail "slack-notifier answered HTTP ${status}${error:+: ${error}}"
done
