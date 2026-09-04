const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const actionPath = path.join(__dirname, "action.yml");
const readmePath = path.join(__dirname, "README.md");
const strictConfigValidatorPath = path.join(__dirname, "validate-strict-config.awk");

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
    "c9939a37768c7d0e4dbac047ea2d2e41bd1e0276db4da3752e200dd5722d1f6e",
    "0e71062f61a6d0bc9345a6c20409e34e7b43bee8d991eeb6f5d933340082c758",
    "374c625a4574752dca107cd843236da9deecea879799a86e64fc5c6cd58022df",
    "56b30e9418915503a70391dee75214f30874875d6d567219c6dbe0b05c1ae14c",
    "e5d9b0c8dc8f823e9b9a87333ae80cd377c7bac5b8d467ccac5624734cd5e9e7",
  ]) {
    assert.match(action, new RegExp(digest));
  }
  assert.match(action, /sha256sum --check --strict/);
  assert.match(action, /Get-FileHash -Algorithm SHA256/);
  assert.match(action, /verifier-path:/);
  assert.match(action, /verifier-sha256:/);
  assert.match(action, /id: install-unix/);
  assert.match(action, /id: install-windows/);
  assert.match(action, /GITHUB_OUTPUT/);
  assert.doesNotMatch(action, /GITHUB_ENV/);
  assert.match(action, /cargo-cooldown verifier checksum mismatch/);
  assert.match(action, /cargo-cooldown requires cygpath on Windows/);
  assert.match(action, /USER_CARGO_HOME="\$\(cygpath -u "\$USER_CARGO_HOME"\)"/);
  assert.match(action, /CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE/);
  assert.match(action, /COOLDOWN_INCOMPATIBLE_PUBLISH_AGE: deny/);
  assert.match(action, /COOLDOWN_LOCKFILE_BASELINE: ignore/);
  assert.match(action, /default: "verify"/);
  assert.match(action, /mode must be 'verify' or 'check'/);
  assert.match(action, /git diff --quiet HEAD -- Cargo\.lock/);
  assert.match(action, /allow-user-policy/);
  assert.match(action, /strict-project-config/);
  assert.match(action, /cooldown\.toml must be tracked in strict project config mode/);
  assert.match(action, /git diff --quiet HEAD -- cooldown\.toml/);
  assert.match(action, /validate-strict-config\.awk/);
  assert.match(action, /user cargo-cooldown policy is not allowed/);
  assert.match(action, /unset COOLDOWN_CACHE_DIR COOLDOWN_FALLBACK_ACCEPT COOLDOWN_NOW/);
  assert.match(action, /COOLDOWN_SKIP_REGISTRIES COOLDOWN_TTL_SECONDS/);
  assert.match(action, /CARGO_REGISTRIES_\*_MIN_PUBLISH_AGE/);
  assert.match(action, /trap restore_lockfile EXIT/);
  assert.match(action, /cp -p Cargo\.lock "\$LOCKFILE_SNAPSHOT"/);
  assert.ok(action.includes('"$VERIFIER_EXEC" cooldown --workspace --all-features tree'));
  assert.ok(action.includes('"$VERIFIER_EXEC" cooldown --workspace --all-features check --locked'));
  assert.doesNotMatch(action, /^\s*cargo cooldown /m);
  assert.match(action, /git diff --exit-code HEAD -- Cargo\.lock/);
  assert.doesNotMatch(action, /install-action|cargo-binstall|cargo install/);
});

test("documentation covers project configuration and lockfile behavior", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.match(readme, /`cargo-cooldown` 0\.3\.4/);
  assert.match(readme, /SHA-256 digests pinned in this action/);
  assert.match(readme, /`verifier-path`/);
  assert.match(readme, /`verifier-sha256`/);
  assert.match(readme, /`GITHUB_ENV`/);
  assert.match(readme, /defaults to seven days/);
  assert.match(readme, /`cooldown\.toml`/);
  assert.match(readme, /lockfile-baseline = "ignore"/);
  assert.match(readme, /incompatible-publish-age = "deny"/);
  assert.match(readme, /`allow-user-policy`/);
  assert.match(readme, /`strict-project-config`/);
  assert.match(readme, /regular tracked file/);
  assert.match(readme, /complete `\[\[allow\.exact\]\]` blocks/);
  assert.match(readme, /restores the original lockfile/);
  assert.match(readme, /rather than job environment exports/);
  assert.match(readme, /`verify` \(default\)/);
  assert.match(readme, /`check`/);
  assert.match(readme, /does not protect a later `cargo install`/);
});

test("strict project config accepts only complete exact-version rules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cargo-cooldown-config-"));
  const configPath = path.join(directory, "cooldown.toml");

  try {
    await writeFile(
      configPath,
      '# Reviewed exceptions\n\n[[allow.exact]]\ncrate = "alloy-primitives"\nversion = "1.7.2"\n',
    );
    assert.equal(spawnSync("awk", ["-f", strictConfigValidatorPath, configPath]).status, 0);

    for (const invalid of [
      '[registry]\nglobal-min-publish-age = "0"\n',
      '[[allow.package]]\ncrate = "alloy-primitives"\nmin-publish-age = "0"\n',
      '[[allow.exact]]\ncrate = "alloy-primitives"\n',
      '[[allow.exact]]\ncrate = "alloy-primitives"\nversion = "1.7.2"\nreason = "release"\n',
      '[[allow.exact]]\ncrate = "alloy-primitives"\nversion = "1.7.2"\n\n[[allow.exact]]\ncrate = "alloy-primitives"\nversion = "1.7.2"\n',
    ]) {
      await writeFile(configPath, invalid);
      assert.notEqual(spawnSync("awk", ["-f", strictConfigValidatorPath, configPath]).status, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
