#!/usr/bin/env bash
set -euo pipefail

# Hosted runners provide gh; bare-metal runners may not, or may have an older
# version without the provenance constraints used by the Foundry installer.
help=$(gh attestation verify --help 2>/dev/null || true)
if [[ "$help" == *--signer-workflow* && "$help" == *--source-ref* ]]; then
  exit 0
fi

if [[ "$(uname -s)" != Linux ]]; then
  echo "::error::setup-foundry: GitHub CLI bootstrap supports Linux only"
  exit 1
fi

version=2.102.0
case "$(uname -m)" in
  x86_64)
    arch=amd64
    sha256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
    ;;
  aarch64|arm64)
    arch=arm64
    sha256=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
    ;;
  *)
    echo "::error::setup-foundry: unsupported architecture $(uname -m)"
    exit 1
    ;;
esac

# Pin the bootstrap archive itself: a checksum fetched alongside it would not
# establish trust in the verifier. Use a fresh directory on persistent runners.
install_dir=$(mktemp -d "${RUNNER_TEMP:?}/foundry-gh.XXXXXX")
asset="gh_${version}_linux_${arch}.tar.gz"
archive="$install_dir/$asset"
curl -fsSL --connect-timeout 10 --retry 3 --retry-all-errors --max-time 120 -o "$archive" "https://github.com/cli/cli/releases/download/v${version}/${asset}"
echo "$sha256  $archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$install_dir" --strip-components=1 "gh_${version}_linux_${arch}/bin/gh"

# The digest establishes the bootstrap trust; also verify the publisher's
# provenance before exposing the CLI to subsequent steps.
"$install_dir/bin/gh" attestation verify "$archive" --repo cli/cli \
  --signer-workflow cli/cli/.github/workflows/deployment.yml \
  --source-ref refs/heads/trunk
"$install_dir/bin/gh" --version
echo "$install_dir/bin" >> "${GITHUB_PATH:?}"
