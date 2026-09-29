const { spawn } = require("node:child_process");
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
  wake = wakeWindowsAgent,
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
  const alreadyPosted = files.existsSync(post);
  // Retain upstream's Windows session-query process before posting the event.
  // The Windows agent does not reliably acknowledge the event without it.
  const waking = platform === "win32" && !alreadyPosted
    ? wake().catch((error) => warning(error.message, "StepSecurity Windows post signal", env))
    : Promise.resolve();
  try {
    if (!alreadyPosted) files.writeFileSync(post, JSON.stringify({ event: "post" }));
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
  } finally {
    await waking;
  }
}

function wakeWindowsAgent(launch = spawn) {
  return new Promise((resolve, reject) => {
    const child = launch("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "query user; exit $LASTEXITCODE"], {
      stdio: "ignore", shell: false, windowsHide: true, timeout: 10_000,
    });
    child.once("error", reject);
    // Session-query exit status is diagnostic only, as in upstream. Do not
    // detach it: every child must finish before revoking the lease/returning.
    child.once("close", resolve);
  });
}

module.exports = { flushHostedAgent, wakeWindowsAgent };
