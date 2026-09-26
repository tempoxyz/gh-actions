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
  assert.match(downloader, /RELEASE_DOWNLOAD_TIMEOUT_MS = 120 \* 1000/);
  assert.match(downloader, /ATTESTATION_TIMEOUT_MS = 60 \* 1000/);
  // \s+ rather than \n: Windows checkouts use CRLF.
  assert.match(downloader, /"Aegis release download", \{[^}]*execOptions: \{ stdio: "inherit", timeout: RELEASE_DOWNLOAD_TIMEOUT_MS, env: gh\.env \},/);
  assert.match(downloader, /"Aegis provenance verification", \{[^}]*execOptions: \{ stdio: "inherit", timeout: ATTESTATION_TIMEOUT_MS, env: gh\.env \},/);
  assert.match(downloader, /Aegis provenance verification/);
});

test("bounds connection waits and retries every Aegis outbound command", () => {
  const bootstrap = fs.readFileSync(
    path.join(__dirname, "..", "setup-foundry", "ensure-gh.sh"),
    "utf8",
  );
  assert.match(bootstrap, /curl -fsSL --connect-timeout 10 --retry 3 --retry-all-errors --max-time 120 /);
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
      random: () => 0,
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-no-node-"));
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

// Windows checkouts use CRLF; compare against LF so offsets and line anchors hold.
const manifestLF = manifest.replace(/\r\n/g, "\n");

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
  const step = manifestLF.split(/\n    - name: /).slice(1).find((value) => value.startsWith(`${name}\n`));
  assert.ok(step, `step "${name}" must exist`);
  return step;
}

test("every setup stage degrades instead of failing and gates the next stage", () => {
  const order = SETUP_CHAIN.map(([name]) => manifestLF.indexOf(`- name: ${name}\n`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stages must appear in chain order");
  for (const [name, condition] of SETUP_CHAIN) {
    const step = manifestStep(name);
    assert.ok(step.includes(`\n      if: ${condition}\n`), `${name} must be gated on: ${condition}`);
    assert.match(step, /^      continue-on-error: true$/m, `${name} must not fail the job`);
  }
  const report = manifestStep("Report package firewall status");
  assert.ok(manifestLF.indexOf("- name: Report package firewall status") > Math.max(...order));
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
      "::warning title=Package-policy enforcement disabled::Aegis was not installed: " +
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
    assert.deepEqual(lines, ["Aegis installed at /usr/bin/aegis; package downloads are inspected and enforced."], installStage);
  }

  // Nothing failed but nothing installed either: still never silent.
  const everythingSkipped = Object.fromEntries(REPORT_STAGES.map((stage) => [`${stage}_OUTCOME`, "skipped"]));
  assert.match(run(everythingSkipped)[0], /^::warning title=Package-policy enforcement disabled::Aegis was not installed: Aegis setup did not complete\./);
});

function detectScript() {
  const body = manifestStep("Detect fork and GitHub OIDC availability").split(/\n      run: \|\n/)[1];
  assert.ok(body, "the detect step must be a bash block");
  const lines = [];
  for (const line of body.split("\n")) {
    if (line !== "" && !line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  return lines.join("\n");
}

test("degrade warnings are mirrored into the step summary", {
  skip: process.platform === "win32" && "POSIX shell fixture; Windows is covered by the live action matrix",
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-summary-"));
  const run = (script, env) => {
    const summary = path.join(directory, `${crypto.randomUUID()}.md`);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      stdout: result.stdout.trim().split("\n"),
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    };
  };
  try {
    const report = reportScript();
    const degraded = run(report, { AEGIS_BINARY: "", ...chainOutcomes("SOCKET_TOKEN") });
    const [annotation] = degraded.stdout;
    assert.match(annotation, /^::warning title=Package-policy enforcement disabled::/);
    assert.equal(
      degraded.summary,
      `> ⚠️ **Package-policy enforcement disabled:** ${annotation.split("::")[2]}\n`,
      "the summary carries the annotation's message",
    );
    const installed = run(report, { AEGIS_BINARY: "/usr/bin/aegis", ...chainOutcomes(null) });
    assert.equal(installed.summary, "", "an installed firewall writes no degraded summary");

    const output = path.join(directory, "detect.output");
    const fork = run(detectScript(), {
      GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: "pull_request",
      HEAD_REPOSITORY: "fork/gh-actions",
      CURRENT_REPOSITORY: "tempoxyz/gh-actions",
    });
    assert.equal(fs.readFileSync(output, "utf8"), "available=false\n");
    const [forkAnnotation] = fork.stdout;
    assert.match(forkAnnotation, /^::warning title=Package-policy enforcement disabled::This job is running for a fork pull request/);
    assert.equal(
      fork.summary,
      `> ⚠️ **Package-policy enforcement disabled:** ${forkAnnotation.split("::")[2]}\n`,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub CLI retries carry up to 25% jitter", () => {
  const { DOWNLOAD_JITTER_RATIO } = require("./download.cjs");
  assert.equal(DOWNLOAD_JITTER_RATIO, 0.25);
  const delays = [];
  let attempts = 0;
  runGh(["api", "x"], "test", {
    execute: () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connection reset");
      return "ok";
    },
    random: () => 1,
    sleep: (delay) => delays.push(delay),
  });
  assert.deepEqual(delays, [1250, 2500]);
});

const { installAegis } = require("./install.cjs");
const { downloadAndVerify, ghEnvironment } = require("./download.cjs");
const { prepareConfiguration } = require("./token-provider.cjs");

function fakeSpawn(failures = {}) {
  const calls = [];
  const remaining = { ...failures };
  return {
    calls,
    spawn: (command, args, options) => {
      const key = `${command} ${args[0] ?? ""}`.trim();
      calls.push({ command, args, env: options?.env });
      if (remaining[key] > 0) {
        remaining[key] -= 1;
        return { status: 1 };
      }
      return { status: 0 };
    },
  };
}

test("installAegis runs each platform's install sequence and retries where the shell steps did", async () => {
  const env = { RUNNER_TEMP: "/runner/temp", ProgramFiles: "C:\\Program Files", ProgramData: "C:\\ProgramData" };
  const delays = [];
  const sleep = async (delay) => delays.push(delay);
  const made = [];
  const mkdir = (directory) => made.push(directory);

  const linux = fakeSpawn({ "sudo apt-get": 2 });
  const linuxLayout = await installAegis({ platform: "linux", packagePath: "/tmp/aegis.deb", configPath: "/tmp/install.json", env, spawn: linux.spawn, sleep, mkdir });
  assert.deepEqual(linuxLayout, { binary: "/usr/bin/aegis", report: "/var/log/aegis/service.jsonl" });
  assert.deepEqual(linux.calls.map((call) => [call.command, ...call.args]), [
    ["sudo", "apt-get", "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=10", "-o", "Acquire::https::Timeout=10", "install", "-y", "/tmp/aegis.deb"],
    ["sudo", "apt-get", "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=10", "-o", "Acquire::https::Timeout=10", "install", "-y", "/tmp/aegis.deb"],
    ["sudo", "apt-get", "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=10", "-o", "Acquire::https::Timeout=10", "install", "-y", "/tmp/aegis.deb"],
    ["/usr/bin/aegis", "install", "--config", "/tmp/install.json"],
  ]);
  assert.deepEqual(delays, [1000, 2000]);

  const darwin = fakeSpawn();
  const darwinLayout = await installAegis({ platform: "darwin", packagePath: "/tmp/aegis.tar.gz", configPath: "/tmp/install.json", env, spawn: darwin.spawn, sleep, mkdir });
  assert.deepEqual(darwinLayout, { binary: "/usr/local/bin/aegis", report: "/Library/Application Support/Aegis/service.jsonl" });
  const extracted = path.join("/runner/temp", "aegis-extracted");
  assert.deepEqual(darwin.calls.map((call) => [call.command, ...call.args]), [
    ["tar", "-xzf", "/tmp/aegis.tar.gz", "-C", extracted],
    ["sudo", "install", "-m", "0755", path.join(extracted, "aegis"), "/usr/local/bin/aegis"],
    ["/usr/local/bin/aegis", "install", "--config", "/tmp/install.json"],
  ]);

  const windows = fakeSpawn();
  const windowsLayout = await installAegis({ platform: "win32", packagePath: "C:\\t\\aegis.zip", configPath: "C:\\t\\install.json", env, spawn: windows.spawn, sleep, mkdir });
  assert.deepEqual(windowsLayout, { binary: "C:\\Program Files\\Aegis\\aegis.exe", report: "C:\\ProgramData\\Aegis\\service.jsonl" });
  assert.equal(windows.calls[0].command, "powershell");
  assert.match(windows.calls[0].args.at(-1), /Expand-Archive -LiteralPath \$env:AEGIS_PACKAGE -DestinationPath \$env:AEGIS_DIRECTORY -Force/);
  assert.equal(windows.calls[0].env.AEGIS_PACKAGE, "C:\\t\\aegis.zip");
  assert.equal(windows.calls[0].env.AEGIS_DIRECTORY, "C:\\Program Files\\Aegis");
  assert.deepEqual(windows.calls[1], { command: "C:\\Program Files\\Aegis\\aegis.exe", args: ["install", "--config", "C:\\t\\install.json"], env: undefined });
  assert.deepEqual(made, [extracted, "C:\\Program Files\\Aegis"]);

  // A command that keeps failing surfaces after the third attempt.
  const stuck = fakeSpawn({ "/usr/bin/aegis install": 3 });
  await assert.rejects(
    installAegis({ platform: "linux", packagePath: "/tmp/aegis.deb", configPath: "/tmp/install.json", env, spawn: stuck.spawn, sleep, mkdir }),
    /\/usr\/bin\/aegis install exited with status 1/,
  );
  await assert.rejects(installAegis({ platform: "plan9", packagePath: "p", configPath: "c", env }), /Unsupported platform/);
});

test("downloadAndVerify runs gh with the release token and any bootstrapped PATH entries", () => {
  const digest = crypto.createHash("sha256").update("artifact").digest("hex");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-download-unit-"));
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args[0] === "api" && args[1].endsWith("releases/latest")) return JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false });
    if (args[0] === "api") return `${"a".repeat(40)}\n`;
    if (args[0] === "release") {
      const target = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(path.join(target, "aegis-1.2.3-linux-amd64.deb"), "artifact");
      fs.writeFileSync(path.join(target, "SHA256SUMS"), `${digest}  aegis-1.2.3-linux-amd64.deb\n`);
      fs.writeFileSync(path.join(target, "provenance.sigstore.json"), "{}");
      return "";
    }
    return "";
  };
  try {
    const result = downloadAndVerify({
      token: "release-token",
      runnerOS: "Linux",
      runnerArch: "X64",
      env: { PATH: "/usr/bin", RUNNER_TEMP: directory },
      pathEntries: ["/bootstrap/gh/bin"],
      execute,
      sleep: () => {},
    });
    assert.match(result.package, /aegis-1\.2\.3-linux-amd64\.deb$/);
    assert.ok(result.directory.startsWith(directory));
    assert.deepEqual(calls.map((call) => call.args[0]), ["api", "api", "release", "attestation"]);
    for (const call of calls) {
      assert.equal(call.command, "gh");
      assert.equal(call.env.GH_TOKEN, "release-token");
      assert.equal(call.env.PATH, ["/bootstrap/gh/bin", "/usr/bin"].join(path.delimiter));
    }
    assert.throws(() => downloadAndVerify({ token: "", runnerOS: "Linux", runnerArch: "X64" }), /release token is missing/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(ghEnvironment("t", { PATH: "/a" }).PATH, "/a");
});

test("prepareConfiguration starts the provider and writes a private configuration", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-config-unit-"));
  try {
    const config = await prepareConfiguration("socket-token-" + "a".repeat(32), { env: { RUNNER_TEMP: directory }, oidc: {} });
    assert.ok(config.startsWith(directory));
    const parsed = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.deepEqual(parsed.managers, MANAGERS);
    assert.match(parsed.test_token_url, /^http:\/\/127\.0\.0\.1:\d+\//);
    if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    const response = await fetch(parsed.test_token_url, { method: "POST" });
    assert.equal(response.status, 200);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
