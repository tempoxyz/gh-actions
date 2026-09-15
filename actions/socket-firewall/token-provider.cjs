const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MANAGERS = [
  "npm", "pnpm", "yarn", "yarn-berry", "bun", "cargo", "go",
  "pip", "uv", "poetry", "gem", "bundler",
];

function appendOutput(name, value, output = process.env.GITHUB_OUTPUT) {
  if (!output || /[\r\n]/.test(value)) throw new Error(`Invalid ${name} output`);
  fs.appendFileSync(output, `${name}=${value}\n`);
}

function childEnvironment() {
  if (process.platform !== "win32") return {};
  return Object.fromEntries(
    [["SystemRoot", process.env.SystemRoot], ["WINDIR", process.env.WINDIR]]
      .filter((entry) => entry[1]),
  );
}

async function startProvider(token) {
  if (!/^\S{20,4096}$/.test(token)) throw new Error("Socket token is invalid");
  const child = spawn(process.execPath, [path.join(__dirname, "token-server.cjs")], {
    detached: true,
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket token provider did not start")), 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Socket token provider exited before startup (${code})`));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      if (!message || typeof message.url !== "string") reject(new Error("Socket token provider returned an invalid URL"));
      else resolve(message.url);
    });
  });
  child.send({ token });
  const url = await ready;
  child.disconnect();
  child.unref();
  return { child, url };
}

async function main() {
  const { url } = await startProvider(process.env.INPUT_SOCKET_TOKEN || "");
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "aegis-config-"));
  const config = path.join(directory, "install.json");
  fs.writeFileSync(config, JSON.stringify({ managers: MANAGERS, test_token_url: url }), { mode: 0o600, flag: "wx" });
  appendOutput("path", config);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { MANAGERS, childEnvironment, startProvider };
