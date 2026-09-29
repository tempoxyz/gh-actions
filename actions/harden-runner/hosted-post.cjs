const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { warning } = require("./annotations.cjs");

// The pinned upstream post hook skips agent cleanup when a hosted runner's
// post_event.json already exists, but still renders its security summary.
// Complete that protocol here first: retain the telemetry acknowledgement,
// leave the agent for VM disposal, and avoid teardown/diagnostic subprocesses.
async function flushHostedAgent({
  env = process.env,
  platform = process.platform,
  files = fs,
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") return;
  if (env.STATE_selfHosted === "true" || env.STATE_customVMImage === "true" || env.STATE_monitorStatusCode === "409") return;
  const directory = {
    linux: "/home/agent",
    darwin: "/opt/step-security",
    win32: env.STATE_agentDir || "C:\\agent",
  }[platform];
  if (!directory || !files.existsSync(directory)) return;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const post = paths.join(directory, "post_event.json");
  const done = paths.join(directory, "done.json");
  if (!files.existsSync(post)) files.writeFileSync(post, JSON.stringify({ event: "post" }));
  // Keep upstream's bounded ten-second wait, but observe completion promptly
  // rather than adding up to a second of latency after the upload completes.
  const deadline = now() + 10_000;
  while (!files.existsSync(done)) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      warning("Timed out waiting for the StepSecurity agent's final telemetry upload.", "StepSecurity telemetry flush", env);
      return;
    }
    await sleep(Math.min(100, remaining));
  }
  console.log("StepSecurity telemetry flushed; skipping agent teardown on this GitHub-hosted runner.");
}

module.exports = { flushHostedAgent };
