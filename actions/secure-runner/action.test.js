const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("keeps implicit protection as the default and forwards explicit mode", () => {
  assert.match(manifest, /shims:\n(?:[^\n]*\n)*?    default: "true"/);
  assert.match(manifest, /shims: \$\{\{ inputs\.shims \}\}/);
  assert.match(manifest, /id: firewall\n\s+uses: tempoxyz\/gh-actions\/actions\/socket-firewall@[a-f0-9]{40}\n/);
});

test("exposes the nested action's executable and report outputs", () => {
  for (const output of ["firewall-path-binary", "firewall-path-report"]) {
    assert.ok(manifest.includes("value: ${{ steps.firewall.outputs." + output + " }}"));
  }
});
