const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const parallel = require("../secure-runner/main.cjs");
const serial = require("../secure-runner/serial-benchmark.cjs");
const { startHardenRunner } = require("../secure-runner/harden.cjs");
const harden = require("../harden-runner/pre.cjs");
const { exchange } = require("../socket-sts/main.cjs");
const { downloadAndVerify } = require("../secure-runner/aegis-release.cjs");
const { installAegis } = require("../aegis/install.cjs");

async function benchmark() {
  const variant = process.env.INPUT_VARIANT;
  if (!["serial", "parallel"].includes(variant)) throw new Error("Invalid variant");
  const result = { variant, platform: process.platform, stages: {} };
  const started = performance.now();
  const timed = (name, operation) => async (options) => {
    const start = performance.now();
    const value = await operation(options);
    result.stages[name] = { start: (start - started) / 1000, end: (performance.now() - started) / 1000 };
    return value;
  };
  await (variant === "serial" ? serial : parallel).main({ deps: {
    startHardenRunner: timed("stepsecurity", variant === "serial" ? harden.main : startHardenRunner),
    exchangeSocket: timed("socket_credentials", exchange),
    ensureCli: timed("github_cli", parallel.ensureGitHubCli),
    download: timed("download_and_verify", downloadAndVerify),
    install: timed("install", installAegis),
  } });
  result.seconds = (performance.now() - started) / 1000;
  console.log(`AEGIS_PARALLEL_BENCHMARK ${JSON.stringify(result)}`);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "parallel-benchmark.json"), JSON.stringify(result, null, 2));
  if (!result.stages.install) throw new Error("Aegis did not install");
  if (process.platform === "linux") {
    const check = spawnSync("sudo", ["systemctl", "is-active", "--quiet", "agent.service", "aegis.service", "aegis-relay.socket", "aegis-nft.service"], { stdio: "inherit" });
    if (check.status !== 0) throw new Error("Security services are not active");
  }
}

benchmark().catch((error) => { console.error(error); process.exitCode = 1; });
