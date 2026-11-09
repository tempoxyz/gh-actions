#!/usr/bin/env bash
set -euo pipefail
export GH_HOST=github.com
REPO=foundry-rs/foundry
if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
  echo "::error::setup-foundry: version must be stable, nightly, a release tag or a nightly build tag"
  exit 1
fi
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "::error::setup-foundry: unsupported architecture $(uname -m)"; exit 1 ;;
esac

# Foundry publishes every stable release as vX.Y.Z and every nightly build as its own
# nightly-<commit> pre-release, each with attested assets. The rolling `stable` and
# `nightly` releases are not attested, so the moving names resolve to the newest tagged one.
case "$VERSION" in
  stable)  TAG=$(gh release list -R "$REPO" --exclude-pre-releases --exclude-drafts --limit 1 --json tagName --jq '.[0].tagName // empty') ;;
  nightly) TAG=$(gh release list -R "$REPO" --exclude-drafts --limit 40 --json tagName --jq '[.[].tagName | select(startswith("nightly-"))][0] // empty') ;;
  *)       TAG="$VERSION" ;;
esac
if [ -z "$TAG" ]; then
  echo "::error::setup-foundry: could not resolve Foundry version '$VERSION' to a release"
  exit 1
fi
case "$TAG" in
  nightly-*) LABEL=nightly; SOURCE_REF=refs/heads/master ;;
  *)         LABEL="$TAG"; SOURCE_REF="refs/tags/$TAG" ;;
esac
echo "Installing Foundry $TAG"

ASSET="foundry_${LABEL}_linux_${ARCH}.tar.gz"
INSTALL_DIR="${RUNNER_TEMP:?}/foundry-bin"
mkdir -p "$INSTALL_DIR"

bash "$GITHUB_ACTION_PATH/download-release.sh" "$TAG" "$ASSET" "$INSTALL_DIR/$ASSET"
bash "$GITHUB_ACTION_PATH/download-release.sh" "$TAG" "${ASSET%.tar.gz}.sha256" "$INSTALL_DIR/$ASSET.sha256"
echo "$(awk '{print $1}' "$INSTALL_DIR/$ASSET.sha256")  $INSTALL_DIR/$ASSET" | sha256sum -c

# SLSA provenance signed through Sigstore by Foundry's release workflow, verified against
# GitHub's trust roots: built from foundry-rs/foundry at this tag (or master for nightlies).
gh attestation verify "$INSTALL_DIR/$ASSET" \
  --repo "$REPO" \
  --signer-workflow foundry-rs/foundry/.github/workflows/release.yml \
  --source-ref "$SOURCE_REF"

tar -xzf "$INSTALL_DIR/$ASSET" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR"/forge "$INSTALL_DIR"/cast "$INSTALL_DIR"/anvil "$INSTALL_DIR"/chisel
echo "$INSTALL_DIR" >> "$GITHUB_PATH"
echo "tag=$TAG" >> "$GITHUB_OUTPUT"
