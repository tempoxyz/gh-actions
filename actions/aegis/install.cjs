const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const INSTALL_ATTEMPTS = 3;
const defaultSleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

// Where each platform's package puts the binary and the service audit log.
const LAYOUTS = {
  linux: () => ({ binary: "/usr/bin/aegis", report: "/var/log/aegis/service.jsonl" }),
  darwin: () => ({
    binary: "/usr/local/bin/aegis",
    report: "/Library/Application Support/Aegis/service.jsonl",
  }),
  win32: (env) => ({
    binary: path.win32.join(env.ProgramFiles || "C:\\Program Files", "Aegis", "aegis.exe"),
    report: path.win32.join(env.ProgramData || "C:\\ProgramData", "Aegis", "service.jsonl"),
  }),
};

function runCommand(spawn, command, args, options = {}) {
  const result = spawn(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${[command, ...args.slice(0, 1)].join(" ")} exited with status ${result.status}`);
  }
}

// Three attempts, one then two seconds apart, matching the shell steps this
// replaces. The operation is synchronous; only the waits are awaited.
async function retrying(description, operation, { attempts = INSTALL_ATTEMPTS, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      console.log(`${description} failed (attempt ${attempt}/${attempts}); retrying in ${delay / 1000}s.`);
      await sleep(delay);
    }
  }
}

// Installs a verified Aegis package with the given installation configuration
// and returns the binary and audit-log paths. Package installation is retried
// where the shell steps retried it; extraction is not.
async function installAegis({
  platform = process.platform,
  packagePath,
  configPath,
  env = process.env,
  spawn = spawnSync,
  sleep,
  mkdir = (directory) => fs.mkdirSync(directory, { recursive: true }),
} = {}) {
  if (!packagePath || !configPath) throw new Error("Aegis package and configuration paths are required");
  const layout = LAYOUTS[platform]?.(env);
  if (!layout) throw new Error(`Unsupported platform: ${platform}`);
  const retry = (description, operation) => retrying(description, operation, { sleep });

  if (platform === "linux") {
    await retry("apt-get install", () =>
      runCommand(spawn, "sudo", [
        "apt-get",
        "-o", "Acquire::Retries=0",
        "-o", "Acquire::http::Timeout=10",
        "-o", "Acquire::https::Timeout=10",
        "install", "-y", packagePath,
      ]));
    await retry("aegis install", () => runCommand(spawn, layout.binary, ["install", "--config", configPath]));
    return layout;
  }

  if (platform === "darwin") {
    const extract = path.join(env.RUNNER_TEMP || os.tmpdir(), "aegis-extracted");
    mkdir(extract);
    runCommand(spawn, "tar", ["-xzf", packagePath, "-C", extract]);
    runCommand(spawn, "sudo", ["install", "-m", "0755", path.join(extract, "aegis"), layout.binary]);
    await retry("aegis install", () => runCommand(spawn, layout.binary, ["install", "--config", configPath]));
    return layout;
  }

  // Windows. Expand-Archive reads its arguments from the environment so paths
  // never pass through PowerShell quoting.
  const directory = path.win32.dirname(layout.binary);
  mkdir(directory);
  runCommand(spawn, "powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Expand-Archive -LiteralPath $env:AEGIS_PACKAGE -DestinationPath $env:AEGIS_DIRECTORY -Force",
  ], { env: { ...env, AEGIS_PACKAGE: packagePath, AEGIS_DIRECTORY: directory } });
  await retry("aegis install", () => runCommand(spawn, layout.binary, ["install", "--config", configPath]));
  return layout;
}

module.exports = { INSTALL_ATTEMPTS, LAYOUTS, installAegis, retrying, runCommand };
