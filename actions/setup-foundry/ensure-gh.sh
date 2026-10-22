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

version=2.102.1
case "$(uname -m)" in
  x86_64)
    arch=amd64
    sha256=77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b
    ;;
  aarch64|arm64)
    arch=arm64
    sha256=5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af
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
