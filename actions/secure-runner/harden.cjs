const path = require("node:path");
const { spawn } = require("node:child_process");

// Both installers use synchronous subprocesses. Isolate the entire StepSecurity
// handshake and installation so Aegis cannot stall its network requests or vice
// versa. The child appends its existing keys to the same action state file; the
// action's single post hook still owns cleanup for both installations.
function startHardenRunner({ env = process.env, launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(process.execPath, [path.join(__dirname, "../harden-runner/pre.cjs")], {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Harden Runner setup failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

module.exports = { startHardenRunner };
