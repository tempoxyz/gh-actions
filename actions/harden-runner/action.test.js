const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("mints a policy-store credential with the pinned GitHub Script action", () => {
  assert.match(
    manifest,
    /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/,
  );
  assert.match(manifest, /mintStepSecurityToken/);
});

test("passes the minted credential to the pinned Harden Runner action", () => {
  assert.match(
    manifest,
    /step-security\/harden-runner@e14015d583714f6e62063499dc959a02595150a1/,
  );
  assert.match(
    manifest,
    /api-key: \$\{\{ steps\.stepsecurity-token\.outputs\.token \}\}/,
  );
  assert.match(manifest, /use-policy-store: true/);
});
