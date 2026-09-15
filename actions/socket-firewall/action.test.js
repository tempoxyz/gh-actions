const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { RELEASE_TAG, VENDORED_RELEASE, assetName, expectedDigest, sha256 } = require("./download.cjs");
const { PACKAGES, npmCLI } = require("./npm-install.cjs");
const { MANAGERS, childEnvironment, installationSettings, startProvider } = require("./token-provider.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("uses both STS exchanges and the aegis download policy", () => {
  assert.match(manifest, /actions\/socket-firewall\/sts@5338a3746a2ac2ddd88cbede733c79f907aca3a0/);
  assert.match(manifest, /actions\/github-sts@5338a3746a2ac2ddd88cbede733c79f907aca3a0/);
  assert.match(manifest, /scope: tempoxyz\/aegis\r?\n/);
  assert.match(manifest, /policy: download-releases\r?\n/);
  assert.match(manifest, /INPUT_SOCKET_TOKEN: \$\{\{ steps\.socket-token\.outputs\.token \}\}/);
  assert.match(manifest, /aegis install --config/);
});

test("pins the requested release and verifies its checksums and provenance", () => {
  const downloader = fs.readFileSync(path.join(__dirname, "download.cjs"), "utf8");
  assert.match(downloader, /20260915T015503Z-bbee7e9ec71d/);
  assert.match(downloader, /bbee7e9ec71dc63cc9721694f50cb397ce8e59ad/);
  assert.match(downloader, /SHA256SUMS/);
  assert.match(downloader, /provenance\.sigstore\.json/);
  assert.match(downloader, /attestation.*verify/s);
  assert.match(downloader, /tempoxyz\/aegis\/\.github\/workflows\/release\.yml/);
  assert.match(downloader, /--deny-self-hosted-runners/);
});

test("selects the exact release artifact for every supported OS and architecture", () => {
  assert.equal(assetName("Linux", "X64"), "aegis-bbee7e9ec71d-linux-amd64.deb");
  assert.equal(assetName("Linux", "ARM64"), "aegis-bbee7e9ec71d-linux-arm64.deb");
  assert.equal(assetName("macOS", "X64"), "aegis-bbee7e9ec71d-macos-amd64.tar.gz");
  assert.equal(assetName("macOS", "ARM64"), "aegis-bbee7e9ec71d-macos-arm64.tar.gz");
  assert.equal(assetName("Windows", "X64"), "aegis-bbee7e9ec71d-windows-amd64.zip");
  assert.equal(assetName("Windows", "ARM64"), "aegis-bbee7e9ec71d-windows-arm64.zip");
  assert.throws(() => assetName("Plan9", "X64"), /Unsupported runner OS/);
  assert.throws(() => assetName("Linux", "RISCV64"), /Unsupported runner architecture/);
});

test("carries every release package with its published checksum", () => {
  const sums = fs.readFileSync(path.join(VENDORED_RELEASE, "SHA256SUMS"), "utf8");
  assert.equal(RELEASE_TAG, "20260915T015503Z-bbee7e9ec71d");
  for (const runnerOS of ["Linux", "macOS", "Windows"]) {
    for (const runnerArch of ["X64", "ARM64"]) {
      const asset = assetName(runnerOS, runnerArch);
      assert.equal(sha256(path.join(VENDORED_RELEASE, asset)), expectedDigest(sums, asset));
    }
  }
});

test("requires one safe checksum entry for the selected artifact", () => {
  const digest = "a".repeat(64);
  assert.equal(expectedDigest(`${digest}  aegis.zip\n`, "aegis.zip"), digest);
  assert.throws(() => expectedDigest(`${digest}  nested/aegis.zip\n`, "aegis.zip"), /no unique entry/);
  assert.throws(() => expectedDigest(`${digest}  aegis.zip\n${digest}  aegis.zip\n`, "aegis.zip"), /no unique entry/);
});

test("configures all non-Maven managers without passing the token to the provider environment", () => {
  assert.deepEqual(MANAGERS, [
    "npm", "pnpm", "yarn", "yarn-berry", "bun", "cargo", "go",
    "pip", "uv", "poetry", "gem", "bundler",
  ]);
  assert.doesNotMatch(JSON.stringify(childEnvironment()), /SOCKET|TOKEN/i);
  assert.deepEqual(installationSettings(false, "http://127.0.0.1:1234/secret"), {
    managers: MANAGERS,
    test_token_url: "http://127.0.0.1:1234/secret",
  });
  assert.deepEqual(installationSettings(true), {
    managers: MANAGERS,
    disable_enforcement: true,
  });
});

test("serves the Socket token only from its random loopback route", async () => {
  const token = "socket-token-" + "a".repeat(32);
  const { child, url } = await startProvider(token);
  try {
    const response = await fetch(url, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { token });
    const missing = await fetch(new URL("/wrong-route", url), { method: "POST" });
    assert.equal(missing.status, 404);
  } finally {
    child.kill();
  }
});

test("the integration helper bypasses PATH shims and uses the requested packages", () => {
  assert.deepEqual(PACKAGES, {
    allow: "isnumber@1.0.0",
    block: "lodahs@0.0.1-security",
  });
  assert.match(npmCLI(), /npm-cli\.js$/);
});

test("installs vendored Aegis with an explicit warning when a fork has no OIDC", () => {
  const steps = manifest.split(/\n    - name: /).slice(1);
  const detect = steps.find((step) => step.startsWith("Detect fork and GitHub OIDC availability"));
  const download = steps.find((step) => step.startsWith("Download and verify Aegis"));
  const config = steps.find((step) => step.startsWith("Prepare Aegis configuration"));
  assert.match(detect, /ACTIONS_ID_TOKEN_REQUEST_TOKEN:-/);
  assert.match(detect, /HEAD_REPOSITORY.*!=.*CURRENT_REPOSITORY/);
  assert.match(detect, /::warning title=Aegis package-policy enforcement disabled::/);
  assert.match(detect, /allow and audit package downloads without Socket policy checks/);
  assert.match(detect, /::error::ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing[^\r\n]*\r?\n\s+exit 1/);
  assert.match(download, /AEGIS_USE_VENDORED_RELEASE: \$\{\{ steps\.oidc\.outputs\.fork \}\}/);
  assert.match(config, /INPUT_DISABLE_ENFORCEMENT: \$\{\{ steps\.oidc\.outputs\.fork \}\}/);
  assert.doesNotMatch(manifest, /Socket Firewall Free/);
  assert.doesNotMatch(manifest, /vendor\/SocketDev\/action/);
});

test("forwards the Aegis binary and audit log through the compatibility outputs", () => {
  assert.match(manifest, /steps\.install-linux\.outputs\.path/);
  assert.match(manifest, /steps\.install-macos\.outputs\.path/);
  assert.match(manifest, /steps\.install-windows\.outputs\.path/);
  assert.match(manifest, /steps\.install-linux\.outputs\.report/);
  assert.match(manifest, /steps\.install-macos\.outputs\.report/);
  assert.match(manifest, /steps\.install-windows\.outputs\.report/);
});
