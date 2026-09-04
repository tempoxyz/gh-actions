const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const actionPath = path.join(__dirname, "action.yml");
const readmePath = path.join(__dirname, "README.md");

test("action installs a pinned cargo-cooldown and runs it fail closed", async () => {
  const action = await readFile(actionPath, "utf8");

  assert.match(action, /using: "composite"/);
  assert.match(action, /CARGO_COOLDOWN_VERSION: "0\.3\.4"/);
  for (const digest of [
    "5706c1636415b90ec8244631ff707d1c49d502779d14235d7abb65c080ac8ba6",
    "bc5488d892da21575f1834ad31c64077f2a681ea70d22e4409fa3f21857cf63a",
    "fd7e8627a8248f3e803a866a893cd3ec2db29c215dee16357caa4d23a36c86f0",
    "0499a6ff956cd1bfb4b29466cbbf1ceb4571a1d1c0eabfe84bffa487e2b11d4b",
    "e3ec5ad658caa1e94ed133437ff93f503ccc3184a8a5cd56911682a55374fe9c",
  ]) {
    assert.match(action, new RegExp(digest));
  }
  assert.match(action, /sha256sum --check --strict/);
  assert.match(action, /Get-FileHash -Algorithm SHA256/);
  assert.match(action, /CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE/);
  assert.match(action, /COOLDOWN_INCOMPATIBLE_PUBLISH_AGE: deny/);
  assert.match(action, /COOLDOWN_LOCKFILE_BASELINE: ignore/);
  assert.match(action, /default: "verify"/);
  assert.match(action, /mode must be 'verify' or 'check'/);
  assert.match(action, /git diff --quiet HEAD -- Cargo\.lock/);
  assert.match(
    action,
    /cargo cooldown --workspace --all-features tree \\\n\s+--locked --depth 0 >\/dev\/null/,
  );
  assert.match(action, /cargo cooldown --workspace --all-features check --locked/);
  assert.match(action, /git diff --exit-code HEAD -- Cargo\.lock/);
  assert.doesNotMatch(action, /install-action|cargo-binstall|cargo install/);
});

test("documentation covers project configuration and lockfile behavior", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /`cargo-cooldown` 0\.3\.4/);
  assert.match(readme, /SHA-256 digests pinned in this action/);
  assert.match(readme, /defaults to seven days/);
  assert.match(readme, /`cooldown\.toml`/);
  assert.match(readme, /lockfile-baseline = "ignore"/);
  assert.match(readme, /incompatible-publish-age = "deny"/);
  assert.match(readme, /`verify` \(default\)/);
  assert.match(readme, /`check`/);
  assert.match(readme, /does not protect a later `cargo install`/);
});
