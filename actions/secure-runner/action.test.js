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
    /uses: \$\/actions\/harden-runner/,
  );
});

test("uses the self-referential Socket Firewall action with bundled Node", () => {
  assert.match(
    manifest,
    /uses: \$\/actions\/socket-firewall/,
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
