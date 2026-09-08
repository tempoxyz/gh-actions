const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("composes the pinned Socket STS and vendored Firewall actions", () => {
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/actions\/socket-firewall\/sts@0f195471b66fe3e39f538383f67bfc0676a3aaa5/,
  );
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/vendor\/SocketDev\/action@0f195471b66fe3e39f538383f67bfc0676a3aaa5/,
  );
  assert.doesNotMatch(manifest, /^\s+uses:\s+SocketDev\/action@/m);
  assert.match(manifest, /mode: firewall-enterprise/);
  assert.match(manifest, /dev: \$\{\{ inputs\.dev \}\}/);
  assert.match(manifest, /socket-token: \$\{\{ steps\.socket-token\.outputs\.token \}\}/);
});

test("forwards both Firewall outputs", () => {
  assert.match(
    manifest,
    /value: \$\{\{ steps\.windows-binary\.outputs\.path \|\| steps\.firewall\.outputs\.firewall-path-binary \}\}/,
  );
  assert.match(
    manifest,
    /value: \$\{\{ steps\.firewall\.outputs\.firewall-path-report \}\}/,
  );
});
