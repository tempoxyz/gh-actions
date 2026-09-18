const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assetName, expectedDigest } = require("./download.cjs");
const { PACKAGES, npmCLI } = require("./npm-install.cjs");
const { MANAGERS, childEnvironment, startProvider } = require("./token-provider.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("uses both STS exchanges and the aegis download policy", () => {
  assert.match(manifest, /actions\/socket-sts@9e86c566882f325b2fc981650396c4de0a34a6c9/);
  assert.match(manifest, /actions\/github-sts@e080a269a3d37e571ad64e94f72536b48eb9921c/);
  assert.match(manifest, /scope: tempoxyz\/aegis\r?\n/);
  assert.match(manifest, /policy: download-releases\r?\n/);
  assert.match(manifest, /dev: \$\{\{ inputs\.dev \}\}/);
  assert.match(manifest, /INPUT_SOCKET_TOKEN: \$\{\{ steps\.socket-token\.outputs\.token \}\}/);
  assert.match(manifest, /aegis install --config/);
});

test("downloads the latest stable release and verifies its checksums and provenance", () => {
  const downloader = fs.readFileSync(path.join(__dirname, "download.cjs"), "utf8");
  assert.match(downloader, /repos\/tempoxyz\/aegis\/releases\/latest/);
  assert.match(downloader, /response\.draft \|\| response\.prerelease/);
  assert.doesNotMatch(downloader, /RELEASE_TAG|RELEASE_COMMIT|RELEASE_VERSION/);
  assert.match(downloader, /SHA256SUMS/);
  assert.match(downloader, /provenance\.sigstore\.json/);
  assert.match(downloader, /attestation.*verify/s);
  assert.match(downloader, /tempoxyz\/aegis\/\.github\/workflows\/release\.yml/);
  assert.match(downloader, /"--source-ref", "refs\/heads\/main"/);
  assert.match(downloader, /--deny-self-hosted-runners/);
});

test("selects the exact latest-release artifact for every supported OS and architecture", () => {
  assert.equal(assetName("1.2.3", "Linux", "X64"), "aegis-1.2.3-linux-amd64.deb");
  assert.equal(assetName("1.2.3", "Linux", "ARM64"), "aegis-1.2.3-linux-arm64.deb");
  assert.equal(assetName("1.2.3", "macOS", "X64"), "aegis-1.2.3-macos-amd64.tar.gz");
  assert.equal(assetName("1.2.3", "macOS", "ARM64"), "aegis-1.2.3-macos-arm64.tar.gz");
  assert.equal(assetName("1.2.3", "Windows", "X64"), "aegis-1.2.3-windows-amd64.zip");
  assert.equal(assetName("1.2.3", "Windows", "ARM64"), "aegis-1.2.3-windows-arm64.zip");
  assert.throws(() => assetName("1.2.3", "Plan9", "X64"), /Unsupported runner OS/);
  assert.throws(() => assetName("1.2.3", "Linux", "RISCV64"), /Unsupported runner architecture/);
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

test("fork pull requests emit a warning and skip all enforcement setup", () => {
  const steps = manifest.split(/\n    - name: /).slice(1);
  const detect = steps.find((step) => step.startsWith("Detect fork and GitHub OIDC availability"));
  assert.match(detect, /ACTIONS_ID_TOKEN_REQUEST_TOKEN:-/);
  assert.match(detect, /HEAD_REPOSITORY.*!=.*CURRENT_REPOSITORY/);
  assert.match(detect, /::warning title=Package-policy enforcement disabled::/);
  assert.match(detect, /No package firewall will be installed; downloads will not be inspected or blocked/);
  assert.match(detect, /::error::ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing[^\r\n]*\r?\n\s+exit 1/);
  for (const name of [
    "Exchange GitHub OIDC token for a Socket token",
    "Exchange GitHub OIDC token for Aegis release access",
    "Download and verify Aegis",
    "Prepare Aegis configuration",
    "Install Aegis package on Linux",
    "Install Aegis package on macOS",
    "Install Aegis package on Windows",
  ]) {
    assert.match(steps.find((step) => step.startsWith(name)), /^\s+if: steps\.oidc\.outputs\.available == 'true'/m, name);
  }
  assert.doesNotMatch(manifest, /AEGIS_USE_VENDORED_RELEASE|disable_enforcement/);
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
