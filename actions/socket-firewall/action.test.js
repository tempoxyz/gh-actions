const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("composes the migrated Socket STS and pinned Firewall actions", () => {
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/actions\/socket-firewall\/sts@09c541105b7d4e1b23343560e2438f48d874d3bb/,
  );
  assert.match(
    manifest,
    /SocketDev\/action@be1f253a41351d59095f8d7f1425985097dd1054/,
  );
  assert.match(manifest, /mode: firewall-enterprise/);
  assert.match(manifest, /dev: \$\{\{ inputs\.dev \}\}/);
  assert.match(manifest, /socket-token: \$\{\{ steps\.socket-token\.outputs\.token \}\}/);
});

test("forwards both Firewall outputs", () => {
  assert.match(
    manifest,
    /value: \$\{\{ steps\.firewall\.outputs\.firewall-path-binary \}\}/,
  );
  assert.match(
    manifest,
    /value: \$\{\{ steps\.firewall\.outputs\.firewall-path-report \}\}/,
  );
});
