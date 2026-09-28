const { spawn } = require("node:child_process");

// Keep the event loop free for the Socket exchange while bootstrapping gh or
// verifying provenance. Wait for close so no subprocess outlives its stage.
function runCommand(command, args, options = {}, launch = spawn) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

module.exports = { runCommand };
