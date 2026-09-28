const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { main } = require("../secure-runner/main.cjs");
const { installAegis } = require("../aegis/install.cjs");

async function benchmark() {
  const variant = process.env.INPUT_VARIANT;
  if (!["apt", "dpkg"].includes(variant)) throw new Error("Invalid benchmark variant");
  const result = { variant, commands: [], installed: false };
  const started = performance.now();
  await main({ deps: {
    install: async (options) => {
      const installStarted = performance.now();
      const installed = await installAegis({ ...options, spawn: (command, args, spawnOptions) => {
        const packageInstall = command === "sudo" && args[0] === "dpkg";
        // Reproduce the exact base-branch APT command at the same point in
        // the pipeline, with the same verified package and fresh runner.
        if (packageInstall && variant === "apt") {
          args = ["apt-get", "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=10",
            "-o", "Acquire::https::Timeout=10", "install", "-y", options.packagePath];
        }
        const commandStarted = performance.now();
        const execution = spawnSync(command, args, spawnOptions);
        result.commands.push({ stage: packageInstall ? "package" : "configure", status: execution.status,
          seconds: (performance.now() - commandStarted) / 1000 });
        return execution;
      } });
      result.install_seconds = (performance.now() - installStarted) / 1000;
      result.installed = true;
      return installed;
    },
  } });
  result.secure_runner_seconds = (performance.now() - started) / 1000;
  console.log(`AEGIS_BENCHMARK ${JSON.stringify(result)}`);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "aegis-install-benchmark.json"), JSON.stringify(result, null, 2));
  if (!result.installed || result.commands.some((command) => command.status !== 0)) {
    throw new Error("Benchmark installation failed or required a fallback");
  }
  const check = spawnSync("sudo", ["systemctl", "is-active", "--quiet", "aegis.service", "aegis-relay.socket", "aegis-nft.service"], { stdio: "inherit" });
  if (check.status !== 0) throw new Error("Aegis services are not active");
}

benchmark().catch((error) => { console.error(error); process.exitCode = 1; });
