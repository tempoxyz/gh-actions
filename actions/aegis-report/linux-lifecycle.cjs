const { execFileSync, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const CONFIG = "/etc/aegis/config.json";
const JOURNAL = "/etc/aegis/journal.json";

function identity(config) {
  if (typeof config.test_token_url !== "string" || !config.test_token_url) {
    throw new Error("CI Aegis configuration has no token-provider identity");
  }
  return createHash("sha256").update(config.test_token_url).digest("hex");
}

function retire({ expectedIdentity, run = execFileSync } = {}) {
  const options = { encoding: "utf8", timeout: 120_000 };
  // Distinguish a missing installation from an inability to inspect root state.
  run("sudo", ["-n", "true"], options);
  const exists = (file) => {
    try {
      run("sudo", ["-n", "test", "-f", file], options);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  };
  const configExists = exists(CONFIG);
  const journalExists = exists(JOURNAL);
  if (!configExists && !journalExists) return;
  if (!configExists || !journalExists) {
    throw new Error("Incomplete Aegis installation; refusing to discard recovery state");
  }
  if (expectedIdentity) {
    const installed = JSON.parse(run("sudo", ["-n", "cat", CONFIG], options));
    if (identity(installed) !== expectedIdentity) {
      throw new Error("Aegis installation belongs to another invocation; refusing cleanup");
    }
  }
  run("sudo", ["-n", "/usr/bin/aegis", "uninstall", "--config", CONFIG], {
    ...options, stdio: "inherit",
  });
}

function retireAsync({ expectedIdentity, launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(process.execPath, [__filename, expectedIdentity], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Aegis cleanup failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}

function quiesceAsync({ expectedIdentity, launch = spawn } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedIdentity || "")) {
    return Promise.reject(new Error("Aegis job-end cleanup requires an installation identity"));
  }
  return new Promise((resolve, reject) => {
    // The client caps local IPC + Worker ACK at 250ms. Bound the whole command
    // too, including sudo/startup; kill only this CLI, never the inspector.
    // The inspector owns cancellation and asynchronous normal socket closure.
    const child = launch("sudo", ["-n", "/usr/bin/aegis", "end-job", "--config", CONFIG,
      "--expected-identity", expectedIdentity], {
      // Ignore stdio and wait for exit: inherited output pipes must not keep
      // credential cleanup waiting for a descendant after the CLI has exited.
      stdio: "ignore", timeout: 500, killSignal: "SIGKILL",
    });
    const failed = () => reject(new Error("Aegis job-end acknowledgement unavailable; continuing credential cleanup"));
    child.once("error", failed);
    child.once("exit", (code) => { if (code === 0) resolve(); else failed(); });
  });
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("Aegis cleanup requires an installation identity");
    retire({ expectedIdentity: process.argv[2] });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { identity, retire, retireAsync, quiesceAsync };
