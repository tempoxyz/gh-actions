const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const actionPath = path.join(__dirname, "action.yml");
const readmePath = path.join(__dirname, "README.md");

test("action installs a pinned cargo-cooldown and runs it fail closed", async () => {
  const action = await readFile(actionPath, "utf8");

  assert.match(action, /using: "composite"/);
  assert.match(action, /tool: cargo-cooldown@0\.3\.4/);
  assert.match(action, /CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE/);
  assert.match(action, /COOLDOWN_INCOMPATIBLE_PUBLISH_AGE: deny/);
  assert.match(action, /COOLDOWN_LOCKFILE_BASELINE: ignore/);
  assert.match(action, /git diff --quiet HEAD -- Cargo\.lock/);
  assert.match(action, /cargo cooldown --workspace --all-features check --locked/);
  assert.match(action, /git diff --exit-code HEAD -- Cargo\.lock/);
  assert.doesNotMatch(action, /curl|cargo install/);
});

test("documentation covers project configuration and lockfile behavior", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /`cargo-cooldown` 0\.3\.4/);
  assert.match(readme, /defaults to seven days/);
  assert.match(readme, /`cooldown\.toml`/);
  assert.match(readme, /lockfile-baseline = "ignore"/);
  assert.match(readme, /incompatible-publish-age = "deny"/);
  assert.match(readme, /does not protect a later `cargo install`/);
});
