const started = performance.now();
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { main } = require("./post.cjs");
const env = { ...process.env };
const variant = env["INPUT_BENCHMARK-VARIANT"];
const simulated = env["INPUT_BENCHMARK-SELF-HOSTED"] === "true";
if (simulated) env.RUNNER_ENVIRONMENT = "self-hosted";
let uploaded = false;
const log = console.log;
console.log = (...args) => {
  if (args.some((arg) => String(arg).includes("Uploaded Aegis audit log as artifact"))) uploaded = true;
  log(...args);
};
main({ env }).then(() => {
  log(`POST_BENCHMARK ${JSON.stringify({ variant, simulated, platform: process.platform, ms: performance.now() - started })}`);
  assert.ok(uploaded, "audit artifact upload must succeed");
  assert.ok(env.STATE_socket_token, "setup must mint a Socket token");
  if (process.platform === "linux") {
    assert.ok(env.STATE_aegis_installation_identity, "setup must install Aegis");
    const result = spawnSync("sudo", ["-n", "test", "-f", "/etc/aegis/config.json"]);
    assert.equal(result.status, variant === "parallel" && !simulated ? 0 : 1);
  }
  log("POST_BENCHMARK_VALIDATED artifact uploaded and expected installation state verified");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
