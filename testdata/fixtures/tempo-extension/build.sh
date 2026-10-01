#!/usr/bin/env bash
# Writes a stand-in extension binary for the tempo-extension workflow smoke test.
set -euo pipefail
cat > "$EXTENSION_OUTPUT" <<SCRIPT
#!/bin/sh
echo "$EXTENSION_PACKAGE $EXTENSION_VERSION ($EXTENSION_SUFFIX)"
SCRIPT
chmod +x "$EXTENSION_OUTPUT"
