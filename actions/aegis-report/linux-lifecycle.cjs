const { execFileSync } = require("node:child_process");
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

module.exports = { identity, retire };
