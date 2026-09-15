const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { assetName, expectedDigest } = require("./download.cjs");
const { PACKAGES, npmCLI } = require("./npm-install.cjs");
const { MANAGERS, childEnvironment, startProvider } = require("./token-provider.cjs");

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
  assert.match(downloader, /20260915T010858Z-9c8efabdc447/);
  assert.match(downloader, /9c8efabdc4473eff4c3695e443179d9d84bc5ba0/);
  assert.match(downloader, /SHA256SUMS/);
  assert.match(downloader, /provenance\.sigstore\.json/);
  assert.match(downloader, /attestation.*verify/s);
  assert.match(downloader, /tempoxyz\/aegis\/\.github\/workflows\/release\.yml/);
  assert.match(downloader, /--deny-self-hosted-runners/);
});

test("selects the exact release artifact for every supported OS and architecture", () => {
  assert.equal(assetName("Linux", "X64"), "aegis-9c8efabdc447-linux-amd64.deb");
  assert.equal(assetName("Linux", "ARM64"), "aegis-9c8efabdc447-linux-arm64.deb");
  assert.equal(assetName("macOS", "X64"), "aegis-9c8efabdc447-macos-amd64.tar.gz");
  assert.equal(assetName("macOS", "ARM64"), "aegis-9c8efabdc447-macos-arm64.tar.gz");
  assert.equal(assetName("Windows", "X64"), "aegis-9c8efabdc447-windows-amd64.zip");
  assert.equal(assetName("Windows", "ARM64"), "aegis-9c8efabdc447-windows-arm64.zip");
  assert.throws(() => assetName("Plan9", "X64"), /Unsupported runner OS/);
  assert.throws(() => assetName("Linux", "RISCV64"), /Unsupported runner architecture/);
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

test("falls back to Socket Firewall Free only for pull requests without OIDC", () => {
  const steps = manifest.split(/\n    - name: /).slice(1);
  const detect = steps.find((step) => step.startsWith("Detect GitHub OIDC availability"));
  const fallback = steps.find((step) => step.startsWith("Install Socket Firewall Free"));
  assert.match(detect, /ACTIONS_ID_TOKEN_REQUEST_TOKEN:-/);
  assert.match(detect, /= "pull_request" \]/);
  assert.match(detect, /::warning::.*Socket Firewall Free/);
  assert.match(detect, /::error::ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing[^\r\n]*\r?\n\s+exit 1/);
  assert.match(fallback, /^\s+if: steps\.oidc\.outputs\.available == 'false'\r?$/m);
  assert.match(fallback, /vendor\/SocketDev\/action@5338a3746a2ac2ddd88cbede733c79f907aca3a0/);
  assert.match(fallback, /mode: firewall\r?\n/);
  assert.doesNotMatch(fallback, /socket-token:/);
});

test("forwards the Aegis binary and audit log through the compatibility outputs", () => {
  assert.match(manifest, /steps\.install-linux\.outputs\.path/);
  assert.match(manifest, /steps\.install-macos\.outputs\.path/);
  assert.match(manifest, /steps\.install-windows\.outputs\.path/);
  assert.match(manifest, /steps\.install-linux\.outputs\.report/);
  assert.match(manifest, /steps\.install-macos\.outputs\.report/);
  assert.match(manifest, /steps\.install-windows\.outputs\.report/);
});
