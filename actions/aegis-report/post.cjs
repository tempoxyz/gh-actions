const { uploadAegisReport } = require("./dist/artifact-upload.cjs");

async function main() {
  try {
    await uploadAegisReport({ action: process.env.STATE_action || "aegis-report" });
  } catch (error) {
    console.log(`::warning title=Aegis audit-log upload failed::${error.message}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
