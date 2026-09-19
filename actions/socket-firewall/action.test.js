const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { assetName, expectedDigest } = require("./download.cjs");
const { PACKAGES, npmCLI } = require("./npm-install.cjs");
const { MANAGERS, childEnvironment, startProvider } = require("./token-provider.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("uses both STS exchanges and the aegis download policy", () => {
  assert.match(manifest, /actions\/socket-sts@2eb387ac7ca887ad10c9375253d48243585ea8bf/);
  assert.match(manifest, /actions\/github-sts@0c5eca66caf2483b8ddc5cbddd6a858213467a65/);
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
  const previousPath = process.env.PATH;
  let provider;
  try {
    process.env.PATH = "";
    provider = await startProvider(token);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const { child, url } = provider;
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

test("setup uses the STS runtime without installing Node or modifying PATH", () => {
  for (const script of ["download.cjs", "token-provider.cjs"]) {
    const step = manifest.split(/\n    - name: /).find((value) => value.includes(`/${script}`));
    assert.ok(step);
    assert.match(step, /RUNNER_NODE: \$\{\{ steps\.socket-token\.outputs\.node-path \}\}/);
    assert.ok(step.includes(`run: '"$RUNNER_NODE" "$GITHUB_ACTION_PATH/${script}"'`));
  }
  assert.doesNotMatch(manifest, /actions\/setup-node|GITHUB_PATH|run: node /);
});

test("download works without node on PATH and fails closed on verification errors", {
  skip: process.platform === "win32" && "POSIX shell fixture; Windows is covered by the live action matrix",
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socket-no-node-"));
  const digest = crypto.createHash("sha256").update("artifact").digest("hex");
  try {
    const bin = path.join(directory, "bin with spaces");
    fs.mkdirSync(bin);
    const runtime = path.join(bin, "runner-runtime");
    fs.symlinkSync(process.execPath, runtime);
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
set -eu
case "$1 $2" in
  'api repos/tempoxyz/aegis/releases/latest')
    printf '%s\\n' '{"tag_name":"v1.2.3","draft":false,"prerelease":false}' ;;
  'api repos/tempoxyz/aegis/git/ref/tags/v1.2.3')
    printf '%s\\n' '${"a".repeat(40)}' ;;
  'release download')
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --dir ]; then target=$2; fi
      shift
    done
    printf artifact > "$target/aegis-1.2.3-linux-amd64.deb"
    printf '%s  %s\\n' "$TEST_DIGEST" aegis-1.2.3-linux-amd64.deb > "$target/SHA256SUMS"
    printf '{}' > "$target/provenance.sigstore.json" ;;
  'attestation verify')
    printf '%s\\n' "$@" > "$TEST_ATTESTATION_ARGS"
    exit "$TEST_ATTESTATION_STATUS" ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const command = manifest.match(/run: '([^'\n]*\/download\.cjs[^'\n]*)'/)[1];
    for (const scenario of ["success", "checksum", "provenance"]) {
      const output = path.join(directory, `${scenario}.output`);
      const args = path.join(directory, `${scenario}.args`);
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        encoding: "utf8",
        env: {
          PATH: bin,
          RUNNER_NODE: runtime,
          GITHUB_ACTION_PATH: __dirname,
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: directory,
          GH_TOKEN: "test-release-token",
          RUNNER_OPERATING_SYSTEM: "Linux",
          RUNNER_ARCHITECTURE: "X64",
          TEST_DIGEST: scenario === "checksum" ? "0".repeat(64) : digest,
          TEST_ATTESTATION_ARGS: args,
          TEST_ATTESTATION_STATUS: scenario === "provenance" ? "1" : "0",
        },
      });
      if (scenario === "success") {
        assert.equal(result.status, 0, result.stderr);
        assert.match(fs.readFileSync(output, "utf8"), /package=.*aegis-1\.2\.3-linux-amd64\.deb/);
        const verification = fs.readFileSync(args, "utf8");
        assert.ok(verification.includes("--source-digest\n" + "a".repeat(40)));
        assert.ok(verification.includes("--signer-workflow\ntempoxyz/aegis/.github/workflows/release.yml"));
        assert.ok(verification.includes("--source-ref\nrefs/heads/main"));
        assert.ok(verification.includes("--deny-self-hosted-runners"));
      } else {
        assert.notEqual(result.status, 0, scenario);
        assert.equal(fs.existsSync(output), false, `${scenario} must not publish an artifact`);
      }
      if (scenario === "checksum") assert.equal(fs.existsSync(args), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
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
    "Ensure GitHub CLI supports attestation verification",
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
