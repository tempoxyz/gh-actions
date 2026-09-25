const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("retries transient release-asset download failures", () => {
  for (const asset of [
    "$ASSET",
    "argo-workflows-cli-checksums.txt",
    "argo-workflows-cli-checksums.sig",
  ]) {
    assert.ok(
      manifest.includes(
        `curl -fsSL --connect-timeout 10 --retry 3 -o "$INSTALL_DIR/${asset}"`,
      ),
    );
  }
});
