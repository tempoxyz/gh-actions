const fs = require("node:fs");
const path = require("node:path");
const { aegisReportPath, uploadAegisReport } = require("./dist/artifact-upload.cjs");
const { warning } = require("../harden-runner/annotations.cjs");
const { retire } = require("./linux-lifecycle.cjs");
const { scanRuntimeWarnings, runtimeWarningMessage } = require("./runtime-warnings.cjs");

async function main({
  upload = uploadAegisReport,
  scan = scanRuntimeWarnings,
  cleanup = retire,
  env = process.env,
  platform = process.platform,
} = {}) {
  try {
    const uploadStarted = Date.now();
    try {
      await upload({ action: env.STATE_action || "aegis-report", env });
    } catch (error) {
      warning(error.message, "Aegis audit-log upload failed", env);
    }
    // The uploader makes a readable copy of the root-owned Linux service log
    // before contacting GitHub. Scan it even if the artifact upload failed.
    const source = aegisReportPath(platform, env);
    const copiedLog = path.join(env.RUNNER_TEMP || path.dirname(source), "aegis-service.jsonl");
    try {
      // Ignore a copy left by an earlier job on a reused runner.
      if (fs.existsSync(copiedLog) && fs.statSync(copiedLog).mtimeMs >= uploadStarted - 1000) {
        const message = runtimeWarningMessage(await scan(copiedLog));
        if (message) warning(message, "Aegis runtime warning verdicts", env);
      }
    } catch (error) {
      warning(error.message, "Aegis warning reporting failed", env);
    }
  } catch (error) {
    warning(error.message, "Aegis post-job reporting failed", env);
  } finally {
    if (platform === "linux" && env.STATE_installation_identity) {
      try {
        cleanup({ expectedIdentity: env.STATE_installation_identity });
      } catch (error) {
        // A managed installation left behind on a reused self-hosted runner is
        // not a successful lifecycle, so cleanup failures there still fail the
        // job. A GitHub-hosted runner is discarded after the job, so the same
        // failure only deserves a warning.
        if (env.RUNNER_ENVIRONMENT !== "github-hosted") throw error;
        console.log(
          `::warning title=Aegis cleanup failed::${error.message}. ` +
            "This GitHub-hosted runner is discarded after the job.",
        );
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
