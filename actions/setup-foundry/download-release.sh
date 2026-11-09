#!/usr/bin/env bash
set -euo pipefail

# Only the delivery route changes. The caller must verify the checksum and
# release-workflow provenance before extracting or exposing these bytes.
tag=${1:?release tag required}
asset=${2:?asset name required}
destination=${3:?destination required}
if [[ ! "$tag" =~ ^[a-zA-Z0-9._-]+$ || ! "$asset" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "::error::setup-foundry: invalid release tag or asset name" >&2
  exit 1
fi

# An interrupted transfer must never leave a partial file at the destination.
partial=$(mktemp "${destination}.XXXXXX")
trap 'rm -f "$partial"' EXIT
status=0
response=$(curl -fsSL --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 120 --retry 3 --retry-max-time 180 \
  --write-out '%{http_code} %{http_connect}' -o "$partial" \
  "https://github.com/foundry-rs/foundry/releases/download/$tag/$asset") || status=$?
read -r http proxy <<< "$response"
if [[ "$status" == 0 ]]; then
  mv "$partial" "$destination"
  exit 0
fi

# Missing assets, authorization denials and certificate errors are not outages
# to route around. Retry only transient HTTP or interrupted transport failures.
# A proxy CONNECT denial may be reported as curl 56 with HTTP 000. Check
# both statuses before interpreting a curl transport error as recoverable.
for code in "$http" "$proxy"; do
  case "$code" in
    000|2[0-9][0-9]|408|429|500|502|503|504) ;;
    *)
      echo "::error::setup-foundry: $asset HTTP $http / proxy CONNECT $proxy; refusing fallback" >&2
      exit "$status"
      ;;
  esac
done
case "$status:$http" in
  22:408|22:429|22:500|22:502|22:503|22:504|6:*|7:*|18:*|28:*|52:*|55:*|56:*) ;;
  *)
    echo "::error::setup-foundry: $asset download failed (curl $status, HTTP $http); refusing fallback" >&2
    exit "$status"
    ;;
esac

echo "::warning::setup-foundry: $asset download failed (curl $status, HTTP $http); trying the official release asset API" >&2
# The fixed repository, exact tag/name match and numeric ID keep the fallback
# on this release. gh handles authentication without forwarding a token ourselves.
query="select(.tag_name == \"$tag\" and .draft == false) | .assets[] | select(.name == \"$asset\") | .id"
id=$(timeout --kill-after=5s 30s gh api --hostname github.com "repos/foundry-rs/foundry/releases/tags/$tag" --jq "$query")
if [[ ! "$id" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::setup-foundry: release must contain exactly one asset named $asset" >&2
  exit 1
fi
timeout --kill-after=5s 180s gh api --hostname github.com -H 'Accept: application/octet-stream' \
  "repos/foundry-rs/foundry/releases/assets/$id" > "$partial"
mv "$partial" "$destination"
