const { uploadAegisReport } = require("./dist/artifact-upload.cjs");
const { retire } = require("./linux-lifecycle.cjs");

async function main({ upload = uploadAegisReport, cleanup = retire, env = process.env } = {}) {
  try {
    await upload({ action: env.STATE_action || "aegis-report" });
  } catch (error) {
    console.log(`::warning title=Aegis audit-log upload failed::${error.message}`);
  } finally {
    if (process.platform === "linux" && env.STATE_installation_identity) {
      // Cleanup errors fail the job: leaving a managed installation on a reused
      // runner is not a successful lifecycle, even if its workload passed.
      cleanup({ expectedIdentity: env.STATE_installation_identity });
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
