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
    /uses: tempoxyz\/gh-actions\/actions\/harden-runner@[0-9a-f]{40}/,
  );
});

test("uses the pinned Socket Firewall action with bundled Node", () => {
  assert.match(
    manifest,
    /uses: tempoxyz\/gh-actions\/actions\/socket-firewall@[0-9a-f]{40}/,
  );
  assert.doesNotMatch(manifest, /actions\/setup-node/);
});

test("defaults and forwards the independent STS host overrides", () => {
  assert.match(
    manifest,
    /step-security-sts-host:\n\s+description:[^\n]+\n\s+required: false\n\s+default: "ss-sts\.tempoxyz\.net"/,
  );
  assert.match(
    manifest,
    /socket-sts-host:\n\s+description:[^\n]+\n\s+required: false\n\s+default: "socket-sts\.tempoxyz\.net"/,
  );
  assert.match(
    manifest,
    /step-security-sts-host: \$\{\{ inputs\.step-security-sts-host \}\}/,
  );
  assert.match(
    manifest,
    /socket-sts-host: \$\{\{ inputs\.socket-sts-host \}\}/,
  );
  assert.doesNotMatch(manifest, /\bdev:/);
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
