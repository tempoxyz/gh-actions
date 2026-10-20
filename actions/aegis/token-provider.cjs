const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { runnerOIDCEnvironment } = require("./github-oidc.cjs");

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

async function startProvider(token, oidc = runnerOIDCEnvironment(), socket) {
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
  // The detached service cannot inherit the job environment. Pass only the
  // required credentials over IPC; never put them in argv, env, or config.
  child.send({ token, oidc, socket });
  const url = await ready;
  child.disconnect();
  child.unref();
  return { child, url };
}

// Starts the detached token provider for `token` and writes the Aegis
// installation configuration that points at it. Returns the configuration path.
async function prepareConfiguration(token, { env = process.env, oidc = runnerOIDCEnvironment(env), socket, onProvider } = {}) {
  const { child, url } = await startProvider(token, oidc, socket);
  try {
    onProvider?.(url);
    const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "aegis-config-"));
    const config = path.join(directory, "install.json");
    fs.writeFileSync(config, JSON.stringify({ managers: MANAGERS, test_token_url: url }), { mode: 0o600, flag: "wx" });
    return config;
  } catch (error) { child.kill(); throw error; }
}

// Freeze renewal and collect the still-valid credentials for the existing
// post hook to revoke. A slow/missing local provider cannot hold cleanup open.
async function retireProvider(url, { fetcher = fetch } = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)) throw new Error();
    const response = await fetcher(parsed, { method: "POST", body: JSON.stringify({ retire: true }),
      redirect: "error", signal: AbortSignal.timeout(1_000) });
    if (response.status !== 200) throw new Error();
    const bytes = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 64 * 1024) throw new Error();
      bytes.push(Buffer.from(chunk));
    }
    const tokens = JSON.parse(Buffer.concat(bytes).toString("utf8")).tokens;
    if (!Array.isArray(tokens) || tokens.length > 16 ||
        tokens.some((token) => typeof token !== "string" || !/^\S{20,4096}$/.test(token))) throw new Error();
    return [...new Set(tokens)];
  } catch { throw new Error("Socket token provider cleanup unavailable"); }
}

async function main() {
  appendOutput("path", await prepareConfiguration(process.env.INPUT_SOCKET_TOKEN || ""));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { MANAGERS, childEnvironment, prepareConfiguration, startProvider, retireProvider };
