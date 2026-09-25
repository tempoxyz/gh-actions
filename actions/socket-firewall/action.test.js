const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { GH_API_TIMEOUT_MS, assetName, expectedDigest, runGh } = require("./download.cjs");
const { PACKAGES, npmCLI } = require("./npm-install.cjs");
const { MANAGERS, childEnvironment, startProvider } = require("./token-provider.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("uses both STS exchanges and the aegis download policy", () => {
  assert.match(manifest, /tempoxyz\/gh-actions\/actions\/socket-sts@[0-9a-f]{40}/);
  assert.match(manifest, /upload-aegis-report: "false"/);
  assert.match(manifest, /tempoxyz\/gh-actions\/actions\/aegis-report@[0-9a-f]{40}/);
  const lifecycle = manifest.indexOf("tempoxyz/gh-actions/actions/aegis-report@");
  const linuxInstall = manifest.indexOf("- name: Install Aegis package on Linux");
  assert.ok(linuxInstall !== -1, "the Linux installation step must exist");
  assert.ok(
    lifecycle < linuxInstall,
    "the lifecycle handler must retire the incumbent before upgrading and register post cleanup before installation",
  );
  assert.ok(manifest.indexOf("tempoxyz/gh-actions/actions/socket-sts@") < lifecycle);
  assert.match(manifest, /linux-installation-config:.*runner\.os == 'Linux'.*steps\.config\.outputs\.path/);
  assert.match(manifest, /tempoxyz\/gh-actions\/actions\/github-sts@[0-9a-f]{40}/);
  assert.match(manifest, /scope: tempoxyz\/aegis\r?\n/);
  assert.match(manifest, /policy: download-releases\r?\n/);
  assert.match(manifest, /host: \$\{\{ inputs\.socket-sts-host \}\}/);
  assert.doesNotMatch(manifest, /\bdev:/);
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
  assert.match(downloader, /DOWNLOAD_ATTEMPTS = 3/);
  assert.match(downloader, /--clobber/);
  assert.match(downloader, /GH_API_TIMEOUT_MS = 10 \* 1000/);
  assert.match(downloader, /Aegis provenance verification/);
});

test("bounds connection waits and retries every Socket Firewall outbound command", () => {
  const bootstrap = fs.readFileSync(
    path.join(__dirname, "..", "setup-foundry", "ensure-gh.sh"),
    "utf8",
  );
  assert.match(bootstrap, /curl -fsSL --connect-timeout 10 --retry 3 --retry-all-errors/);
  assert.match(manifest, /retry bash "\$GITHUB_ACTION_PATH\/\.\.\/setup-foundry\/ensure-gh\.sh"/);
  assert.match(manifest, /Acquire::http::Timeout=10/);
  assert.match(manifest, /Acquire::https::Timeout=10/);
  assert.match(manifest, /retry \/usr\/bin\/aegis install/);
  assert.match(manifest, /retry \/usr\/local\/bin\/aegis install/);
  assert.match(manifest, /function Invoke-WithRetry/);
});

test("retries every GitHub CLI failure with exponential backoff", () => {
  let attempts = 0;
  const delays = [];
  const output = runGh(
    ["api", "repos/tempoxyz/aegis/releases/latest"],
    "GitHub latest-release request",
    {
      execute: () => {
        attempts += 1;
        if (attempts < 3) throw new Error("connection reset");
        return "{\"tag_name\":\"v1.2.3\"}";
      },
      execOptions: { encoding: "utf8", timeout: GH_API_TIMEOUT_MS },
      sleep: (delay) => delays.push(delay),
    },
  );

  assert.equal(output, "{\"tag_name\":\"v1.2.3\"}");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
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
    attempts_file=$TEST_DOWNLOAD_ATTEMPTS
    attempts=0
    if [ -f "$attempts_file" ]; then IFS= read -r attempts < "$attempts_file"; fi
    attempts=$((attempts + 1))
    printf '%s\n' "$attempts" > "$attempts_file"
    if [ "$attempts" -le "$TEST_DOWNLOAD_FAILURES" ]; then
      exit 1
    fi
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
    for (const scenario of ["success", "retry", "download", "checksum", "provenance"]) {
      const output = path.join(directory, `${scenario}.output`);
      const args = path.join(directory, `${scenario}.args`);
      const attempts = path.join(directory, `${scenario}.attempts`);
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
          TEST_DOWNLOAD_ATTEMPTS: attempts,
          TEST_DOWNLOAD_FAILURES: scenario === "retry" ? "1" : scenario === "download" ? "3" : "0",
        },
      });
      if (scenario === "success" || scenario === "retry") {
        assert.equal(result.status, 0, result.stderr);
        if (scenario === "retry") assert.equal(fs.readFileSync(attempts, "utf8").trim(), "2");
        assert.match(fs.readFileSync(output, "utf8"), /package=.*aegis-1\.2\.3-linux-amd64\.deb/);
        const verification = fs.readFileSync(args, "utf8");
        assert.ok(verification.includes("--source-digest\n" + "a".repeat(40)));
        assert.ok(verification.includes("--signer-workflow\ntempoxyz/aegis/.github/workflows/release.yml"));
        assert.ok(verification.includes("--source-ref\nrefs/heads/main"));
        assert.ok(verification.includes("--deny-self-hosted-runners"));
      } else {
        assert.notEqual(result.status, 0, scenario);
        assert.equal(fs.existsSync(output), false, `${scenario} must not publish an artifact`);
        if (scenario === "download") assert.equal(fs.readFileSync(attempts, "utf8").trim(), "3");
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
  assert.doesNotMatch(detect, /continue-on-error/, "a missing id-token permission must still fail the job");
  // Only the first exchange and the final report key off OIDC availability;
  // every other stage is gated on its predecessor, so a fork run skips them all.
  for (const name of ["Exchange GitHub OIDC token for a Socket token", "Report package firewall status"]) {
    assert.match(steps.find((step) => step.startsWith(name)), /^\s+if: steps\.oidc\.outputs\.available == 'true'$/m, name);
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

// Stage names paired with the condition that gates them. A stage runs only when
// the previous stage succeeded, so a failure anywhere stops all later work.
const SETUP_CHAIN = [
  ["Exchange GitHub OIDC token for a Socket token", "steps.oidc.outputs.available == 'true'"],
  ["Exchange GitHub OIDC token for Aegis release access", "steps.socket-token.outcome == 'success'"],
  ["Ensure GitHub CLI supports attestation verification", "steps.release-token.outcome == 'success'"],
  ["Download and verify Aegis", "steps.gh-cli.outcome == 'success'"],
  ["Prepare Aegis configuration", "steps.download.outcome == 'success'"],
  ["Prepare Aegis lifecycle and register cleanup", "steps.config.outcome == 'success'"],
  ["Install Aegis package on Linux", "steps.lifecycle.outcome == 'success' && runner.os == 'Linux'"],
  ["Install Aegis package on macOS", "steps.lifecycle.outcome == 'success' && runner.os == 'macOS'"],
  ["Install Aegis package on Windows", "steps.lifecycle.outcome == 'success' && runner.os == 'Windows'"],
];

function manifestStep(name) {
  const step = manifest.split(/\n    - name: /).slice(1).find((value) => value.startsWith(`${name}\n`));
  assert.ok(step, `step "${name}" must exist`);
  return step;
}

test("every setup stage degrades instead of failing and gates the next stage", () => {
  const order = SETUP_CHAIN.map(([name]) => manifest.indexOf(`- name: ${name}\n`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stages must appear in chain order");
  for (const [name, condition] of SETUP_CHAIN) {
    const step = manifestStep(name);
    assert.ok(step.includes(`\n      if: ${condition}\n`), `${name} must be gated on: ${condition}`);
    assert.match(step, /^      continue-on-error: true$/m, `${name} must not fail the job`);
  }
  const report = manifestStep("Report package firewall status");
  assert.ok(manifest.indexOf("- name: Report package firewall status") > Math.max(...order));
  assert.doesNotMatch(report, /continue-on-error/);
  for (const id of ["socket-token", "release-token", "gh-cli", "download", "config", "lifecycle", "install-linux", "install-macos", "install-windows"]) {
    assert.ok(report.includes(`\${{ steps.${id}.outcome }}`), `the report must read the ${id} outcome`);
  }
});

function reportScript() {
  const body = manifestStep("Report package firewall status").split(/\n      run: \|\n/)[1];
  assert.ok(body, "the report step must be a bash block");
  const lines = [];
  for (const line of body.split("\n")) {
    if (line !== "" && !line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  return lines.join("\n");
}

const REPORT_STAGES = [
  "SOCKET_TOKEN", "RELEASE_TOKEN", "GH_CLI", "DOWNLOAD", "CONFIG", "LIFECYCLE",
  "INSTALL_LINUX", "INSTALL_MACOS", "INSTALL_WINDOWS",
];

// Models the chain: stages before the failure succeeded, the failing stage
// failed, and everything after it was skipped. Only one install stage runs.
function chainOutcomes(failedStage, installStage = "INSTALL_LINUX") {
  const outcomes = {};
  let reached = true;
  for (const stage of REPORT_STAGES) {
    const applicable = !stage.startsWith("INSTALL_") || stage === installStage;
    if (!reached || !applicable) outcomes[`${stage}_OUTCOME`] = "skipped";
    else if (stage === failedStage) {
      outcomes[`${stage}_OUTCOME`] = "failure";
      reached = false;
    } else outcomes[`${stage}_OUTCOME`] = "success";
  }
  return outcomes;
}

test("the report step names the first failed stage in a warning annotation", {
  skip: process.platform === "win32" && "POSIX shell fixture; Windows is covered by the live action matrix",
}, () => {
  const script = reportScript();
  assert.match(script, /^set -euo pipefail$/m);
  const run = (env) => {
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, AEGIS_BINARY: "/usr/bin/aegis", ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n");
  };

  const expectations = [
    ["SOCKET_TOKEN", "the Socket STS did not issue a Socket API token"],
    ["RELEASE_TOKEN", "the GitHub STS did not issue an Aegis release download token"],
    ["GH_CLI", "a GitHub CLI with attestation support could not be bootstrapped"],
    ["DOWNLOAD", "the Aegis release could not be downloaded and verified"],
    ["CONFIG", "the Aegis token provider could not be started"],
    ["LIFECYCLE", "the Aegis lifecycle handler could not be prepared"],
    ["INSTALL_LINUX", "the Aegis package could not be installed"],
  ];
  for (const [stage, reason] of expectations) {
    assert.deepEqual(run(chainOutcomes(stage)), [
      "::warning title=Package-policy enforcement disabled::Socket Firewall was not installed: " +
        `${reason}. See the failed step's log for details. No package firewall is running for ` +
        "this job, so package downloads are not inspected or blocked.",
    ], stage);
  }
  for (const installStage of ["INSTALL_MACOS", "INSTALL_WINDOWS"]) {
    const [line] = run(chainOutcomes(installStage, installStage));
    assert.match(line, /^::warning title=Package-policy enforcement disabled::.*the Aegis package could not be installed\./, installStage);
  }

  for (const installStage of ["INSTALL_LINUX", "INSTALL_MACOS", "INSTALL_WINDOWS"]) {
    const lines = run(chainOutcomes(null, installStage));
    assert.deepEqual(lines, ["Socket Firewall installed Aegis at /usr/bin/aegis; package downloads are inspected and enforced."], installStage);
  }

  // Nothing failed but nothing installed either: still never silent.
  const everythingSkipped = Object.fromEntries(REPORT_STAGES.map((stage) => [`${stage}_OUTCOME`, "skipped"]));
  assert.match(run(everythingSkipped)[0], /^::warning title=Package-policy enforcement disabled::Socket Firewall was not installed: Socket Firewall setup did not complete\./);
});
