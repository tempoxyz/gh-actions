const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("uses the Windows ARM64-aware Harden Runner before Socket Firewall", () => {
  const hardenRunner = manifest.indexOf(
    "- name: Harden the runner with the StepSecurity policy store",
  );
  const socketFirewall = manifest.indexOf("- name: Install Socket Firewall");

  assert.ok(hardenRunner >= 0);
  assert.ok(socketFirewall > hardenRunner);
  assert.match(
    manifest,
    /uses: tempoxyz\/gh-actions\/actions\/harden-runner@905ee5bcb4fd76cdc54ca30c97b362b0f2a26390/,
  );
});
