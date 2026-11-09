#!/usr/bin/env bash
set -euo pipefail
export GH_HOST=github.com

# Resolve a moving release only once; the upstream action receives the exact tag.
version=${VERSION:-}
if [[ -z "$version" ]]; then
  version=$(timeout --kill-after=5s 30s gh api --hostname github.com repos/mozilla/sccache/releases/latest \
    --jq 'select(.draft == false and .prerelease == false) | .tag_name')
fi
# Match tool-cache's semver normalization, without accepting ranges as release names.
if [[ ! "$version" =~ ^v?((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?)$ ]]; then
  echo '::error::setup-sccache: expected an exact semantic release tag' >&2
  exit 1
fi
cache_version=${BASH_REMATCH[1]}
if [[ "$cache_version" == *-* ]]; then
  IFS=. read -ra identifiers <<< "${cache_version#*-}"
  for identifier in "${identifiers[@]}"; do
    if [[ "$identifier" =~ ^0[0-9]+$ ]]; then
      echo '::error::setup-sccache: numeric prerelease identifiers cannot have leading zeroes' >&2
      exit 1
    fi
  done
fi
arch=$(node -p 'process.arch')
case "$arch" in
  x64) target=x86_64-unknown-linux-musl ;;
  arm64) target=aarch64-unknown-linux-musl ;;
  arm) target=armv7-unknown-linux-musleabi ;;
  *) echo "::error::setup-sccache: unsupported architecture $arch" >&2; exit 1 ;;
esac
home="${RUNNER_TOOL_CACHE:?}/sccache/$cache_version/$arch"
if [[ -d "$home" && -f "$home.complete" ]]; then
  echo "version=$version" >> "${GITHUB_OUTPUT:?}"
  exit 0
fi

# Keep staging on the same filesystem as the cache so publication is a rename.
mkdir -p "$(dirname "$home")"
staging=$(mktemp -d "$(dirname "$home")/.sccache.XXXXXX")
trap 'rm -rf "$staging"' EXIT
name="sccache-$version-$target"
asset="$name.tar.gz"
bash "${ACTION_PATH:?}/download-release.sh" "$version" "$asset" "$staging/$asset"
bash "$ACTION_PATH/download-release.sh" "$version" "$asset.sha256" "$staging/checksum"
# Upstream checks an exact lowercase digest, not a checksum-list filename supplied by the network.
checksum=$(cat "$staging/checksum")
if [[ ! "$checksum" =~ ^[a-f0-9]{64}$ ]]; then
  echo '::error::setup-sccache: invalid release checksum' >&2
  exit 1
fi
echo "$checksum  $staging/$asset" | sha256sum --check --strict
mkdir "$staging/extracted"
# Only extract the one regular executable, not arbitrary archive paths or links.
python3 - "$staging/$asset" "$name/sccache" "$staging/extracted/sccache" <<'PY'
import shutil
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = [member for member in archive.getmembers() if member.name == sys.argv[2]]
    if len(members) != 1 or not members[0].isfile():
        raise SystemExit('Expected exactly one regular sccache executable')
    with archive.extractfile(members[0]) as source, open(sys.argv[3], 'xb') as target:
        shutil.copyfileobj(source, target)
PY
chmod +x "$staging/extracted/sccache"
# A stale incomplete entry must not masquerade as success. Do not merge directories.
if [[ -e "$home" || -e "$home.complete" ]]; then
  echo "::error::setup-sccache: incomplete tool-cache entry at $home; remove it before retrying" >&2
  exit 1
fi
mv -T "$staging/extracted" "$home"
# Match @actions/tool-cache: the completion marker is written only after the entire tool exists.
touch "$home.complete"
echo "version=$version" >> "${GITHUB_OUTPUT:?}"
