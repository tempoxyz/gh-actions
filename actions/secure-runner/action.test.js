const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("skips only Harden Runner on unsupported Windows ARM64 runners", () => {
  const hardenRunner = manifest.indexOf(
    "- name: Harden the runner with the StepSecurity policy store",
  );
  const warning = manifest.indexOf(
    "- name: Warn when Harden Runner is unavailable",
  );
  const socketFirewall = manifest.indexOf("- name: Install Socket Firewall");

  assert.ok(hardenRunner >= 0);
  assert.ok(warning > hardenRunner);
  assert.ok(socketFirewall > warning);
  assert.match(
    manifest,
    /- name: Harden the runner with the StepSecurity policy store\n\s+if: runner\.os != 'Windows' \|\| runner\.arch != 'ARM64'\n\s+uses:/,
  );
  assert.match(
    manifest,
    /- name: Warn when Harden Runner is unavailable\n\s+if: runner\.os == 'Windows' && runner\.arch == 'ARM64'\n/,
  );

  const socketStep = manifest.slice(socketFirewall);
  assert.doesNotMatch(socketStep, /^\s+if:/m);
});
