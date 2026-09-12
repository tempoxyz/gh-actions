const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bashPath(value) {
  if (!value || /[\r\n\0]/.test(value)) throw new Error("Expected a nonempty, single-line path");
  if (process.platform === "win32") {
    return execFileSync("cygpath", ["-au", value], { encoding: "utf8" }).trim();
  }
  if (!path.isAbsolute(value)) throw new Error("Socket paths and an existing BASH_ENV must be absolute");
  return value;
}

// Match the command set of the pinned Socket installer, including its Free fallback.
function commands(enterprise, platform = process.platform) {
  const result = ["cargo", "npm", "pip", "pip3", "pnpm", "uv", "yarn"];
  if (enterprise) {
    result.push("bundler", "gem", "nuget");
    if (platform === "linux") result.push("go");
  }
  return result;
}

function nativePath(value) {
  return process.platform === "win32"
    ? execFileSync("cygpath", ["-aw", value], { encoding: "utf8" }).trim()
    : value;
}

function install(env = process.env) {
  const binary = bashPath(env.FIREWALL_PATH_BINARY);
  const upstream = bashPath(env.SFW_SHIM_DIR);
  const temporary = nativePath(bashPath(env.RUNNER_TEMP));
  let previous = env.BASH_ENV ? bashPath(env.BASH_ENV) : "";
  let directory;
  // Reinstalling the same action must not build a chain of our own startup hooks.
  if (previous && path.basename(previous) === "bash-hook.sh") {
    const candidate = nativePath(path.posix.dirname(previous));
    const statePath = path.join(candidate, "tempo-sfw-state.json");
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.version !== 1) throw new Error("Unsupported Socket Bash hook state");
      directory = candidate;
      previous = state.previous;
    }
  }
  fs.accessSync(nativePath(binary), fs.constants.X_OK);
  if (previous) fs.accessSync(nativePath(previous), fs.constants.R_OK);
  if (!env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
  directory ??= fs.mkdtempSync(path.join(temporary, "tempo-sfw-"));
  directory = fs.realpathSync(directory);
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  for (const file of ["bash-hook.sh", "bash-common.sh", "bash-launcher.sh", "socket-guard.cjs"]) {
    fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    fs.chmodSync(path.join(directory, file), 0o755);
  }
  const enterprise = Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && env.ACTIONS_ID_TOKEN_REQUEST_URL);
  const config = [
    `_tempo_sfw_binary=${shellQuote(binary)}`,
    `_tempo_sfw_node=${shellQuote(bashPath(process.execPath))}`,
    `_tempo_sfw_bash=${shellQuote(nativePath(bashPath(execFileSync("bash", ["--noprofile", "--norc", "-c", "type -P bash"], { encoding: "utf8" }).trim())))}`,
    `_tempo_sfw_upstream=${shellQuote(upstream)}`,
    `_tempo_sfw_previous=${shellQuote(previous)}`,
    `_tempo_sfw_commands=(${commands(enterprise).map(shellQuote).join(" ")})`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(directory, "config.sh"), config, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "tempo-sfw-state.json"), JSON.stringify({ version: 1, previous }));
  const hook = bashPath(path.join(directory, "bash-hook.sh"));
  fs.appendFileSync(env.GITHUB_ENV, `BASH_ENV=${hook}\n`);
  return { directory, hook, enterprise };
}

if (require.main === module) {
  try {
    const result = install();
    console.log(`Socket Bash interception enabled (${result.enterprise ? "Enterprise" : "Free"})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { install, commands, shellQuote };
