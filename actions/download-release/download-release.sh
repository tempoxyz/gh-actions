#!/usr/bin/env bash
# Source this file; each call isolates its traps and temporary files.
download_release() (
  set -euo pipefail

  # Only the delivery route changes. The caller must verify the checksum and
  # release-workflow provenance before extracting or exposing these bytes.
  repository=${1:?repository required}
  tag=${2:?release tag required}
  asset=${3:?asset name required}
  destination=${4:?destination required}
  case "$repository" in
    suzuki-shunsuke/pinact|rhysd/actionlint|rui314/mold) ;;
    *) echo "::error::download-release: unsupported repository" >&2; exit 1 ;;
  esac
  if [[ ! "$tag" =~ ^[a-zA-Z0-9._-]+$ || ! "$asset" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    echo "::error::download-release: invalid release tag or asset name" >&2
    exit 1
  fi

  # An interrupted transfer must never leave a partial file at the destination.
  partial=$(mktemp "${destination}.XXXXXX")
  download_pid=
  # shellcheck disable=SC2317 # Called by the EXIT trap through cleanup.
  stop_download() {
    if [[ -n "$download_pid" ]]; then
      kill "$download_pid" 2>/dev/null || true
      for ((i = 0; i < 5; i++)); do
        kill -0 "$download_pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$download_pid" 2>/dev/null; then
        kill -KILL "$download_pid" 2>/dev/null || true
      fi
      wait "$download_pid" 2>/dev/null || true
      download_pid=
    fi
  }
  # shellcheck disable=SC2317 # Called indirectly by the EXIT trap.
  cleanup() {
    # Repeated cancellation must not interrupt the forced kill, wait or removal.
    trap '' INT TERM
    trap - EXIT
    stop_download
    rm -f "$partial"
    exit "$1"
  }
  trap 'cleanup "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  status=0
  response=$(curl -fsSL --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --speed-limit 1024 --speed-time 60 --retry 3 --retry-max-time 180 \
    --write-out '%{http_code} %{http_connect}' -o "$partial" \
    "https://github.com/$repository/releases/download/$tag/$asset") || status=$?
  read -r http proxy <<< "$response"
  if [[ "$status" == 0 ]]; then
    mv "$partial" "$destination"
    exit 0
  fi

  # Missing assets, authorization denials and certificate errors are not outages
  # to route around. Retry only transient HTTP or interrupted transport failures.
  # A proxy CONNECT denial may be reported as curl 56 with HTTP 000. Check
  # both statuses before interpreting a curl transport error as recoverable.
  # A failed redirect connection retains the preceding 3xx response; allow that
  # only for the HTTP response, never for a refused proxy CONNECT.
  for field in http proxy; do
    case "$field:${!field}" in
      *:000|*:2[0-9][0-9]|*:408|*:429|*:500|*:502|*:503|*:504|http:301|http:302|http:303|http:307|http:308) ;;
      *)
        echo "::error::download-release: $asset HTTP $http / proxy CONNECT $proxy; refusing fallback" >&2
        exit "$status"
        ;;
    esac
  done
  case "$status:$http" in
    22:408|22:429|22:500|22:502|22:503|22:504|6:*|7:*|18:*|28:*|52:*|55:*|56:*) ;;
    *)
      echo "::error::download-release: $asset download failed (curl $status, HTTP $http); refusing fallback" >&2
      exit "$status"
      ;;
  esac

  echo "::warning::download-release: $asset download failed (curl $status, HTTP $http); trying the official release asset API" >&2
  # The fixed repository, exact tag/name match and numeric ID keep the fallback
  # on this release. gh handles authentication without forwarding a token ourselves.
  query="select(.tag_name == \"$tag\" and .draft == false) | .assets[] | select(.name == \"$asset\") | .id"
  id=$(timeout --kill-after=5s 30s gh api --hostname github.com "repos/$repository/releases/tags/$tag" --jq "$query")
  if [[ ! "$id" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::download-release: release must contain exactly one asset named $asset" >&2
    exit 1
  fi
  # gh streams the response to disk. Bound inactivity rather than elapsed time,
  # so a large archive on a slow but progressing connection can finish.
  : > "$partial"
  gh api --hostname github.com -H 'Accept: application/octet-stream' \
    "repos/$repository/releases/assets/$id" > "$partial" &
  download_pid=$!
  last_size=0
  progress_at=$SECONDS
  while kill -0 "$download_pid" 2>/dev/null; do
    size=$(stat -c %s -- "$partial")
    if ((size > last_size)); then
      last_size=$size
      progress_at=$SECONDS
    fi
    if ((SECONDS - progress_at >= 60)) && kill -0 "$download_pid" 2>/dev/null; then
      echo "::error::download-release: $asset API download made no progress for 60 seconds" >&2
      exit 124
    fi
    sleep 1
  done
  status=0
  wait "$download_pid" || status=$?
  download_pid=
  if [[ "$status" != 0 ]]; then exit "$status"; fi
  mv "$partial" "$destination"
)
