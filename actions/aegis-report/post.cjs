const { uploadAegisReport } = require("./dist/artifact-upload.cjs");
const { retire } = require("./linux-lifecycle.cjs");

async function main({
  upload = uploadAegisReport,
  cleanup = retire,
  env = process.env,
  platform = process.platform,
} = {}) {
  try {
    await upload({ action: env.STATE_action || "aegis-report" });
  } catch (error) {
    console.log(`::warning title=Aegis audit-log upload failed::${error.message}`);
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
