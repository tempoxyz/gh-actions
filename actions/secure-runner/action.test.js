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
    /uses: tempoxyz\/gh-actions\/actions\/harden-runner@0a60d757d0f4725a34f22f7b9ebf7b91b4b00bcf/,
  );
});

test("pins Socket Firewall with Linux lifecycle management and bundled Node", () => {
  assert.match(
    manifest,
    /uses: tempoxyz\/gh-actions\/actions\/socket-firewall@d7bef0a0614aa95b6f42521e9a18cb0debb8c5e5/,
  );
  assert.doesNotMatch(manifest, /actions\/setup-node/);
});

test("can disable both enforcement layers explicitly", () => {
  assert.match(
    manifest,
    /disable-enforcement:\n\s+description:[^\n]+\n\s+required: false\n\s+default: "false"/,
  );
  assert.match(
    manifest,
    /disable-enforcement: \$\{\{ inputs\.disable-enforcement \}\}/,
  );
  assert.match(
    manifest,
    /- name: Install Socket Firewall\n\s+if: inputs\.disable-enforcement != 'true'\n/,
  );
});
