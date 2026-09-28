const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { execFileSync, spawnSync } = require("node:child_process");
const { createOidcClient } = require("./oidc.cjs");
const { exchange } = require("../socket-sts/main.cjs");
const { installAegis } = require("../aegis/install.cjs");
const { prepareConfiguration } = require("../aegis/token-provider.cjs");
const { runCommand } = require("./command.cjs");
const variant = process.env["INPUT_BENCHMARK-VARIANT"];
const main = require(variant === "serial" ? "./baseline-main.cjs" : "./main.cjs");
const release = require(variant === "serial" ? "./baseline-release.cjs" : "./aegis-release.cjs");
const events = [];
const zero = performance.now();
const now = () => (performance.now() - zero) / 1000;
function timedSync(name, operation) {
  const start = now();
  try { return operation(); } finally { events.push({ name, start, end: now() }); }
}
async function timed(name, operation) {
  const start = now();
  try { return await operation(); } finally { events.push({ name, start, end: now() }); }
}

async function benchmark() {
  const oidc = createOidcClient();
  const execute = variant === "serial"
    ? (...args) => timedSync("verification", () => execFileSync(...args))
    : (...args) => timed("verification", () => runCommand(...args));
  await timed("setup_total", () => main.main({ deps: {
    oidc,
    exchangeSocket: (options) => timed("socket_auth", () => exchange(options)),
    ensureCli: (options) => timed("cli", () => main.ensureGitHubCli(options)),
    download: (options) => timed("download_verify", () => release.downloadAndVerify({ ...options, execute })),
    prepareConfig: (...args) => timed("provider", () => prepareConfiguration(...args)),
    install: (options) => timed("install", () => installAegis(options)),
  } }));
  const result = { variant, os: process.platform, events };
  console.log(`AEGIS_PARALLEL_BENCHMARK ${JSON.stringify(result)}`);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "aegis-parallel-benchmark.json"), JSON.stringify(result, null, 2));
  if (!events.some((event) => event.name === "install")) throw new Error("Aegis installation did not complete");
  if (process.platform === "linux") {
    const check = spawnSync("sudo", ["systemctl", "is-active", "--quiet", "agent.service", "aegis.service", "aegis-relay.socket", "aegis-nft.service"], { stdio: "inherit" });
    if (check.status !== 0) throw new Error("Security services are not active");
  }
}
benchmark().catch((error) => { console.error(error); process.exitCode = 1; });
