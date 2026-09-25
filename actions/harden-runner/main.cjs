const { required } = require("../step-security-sts/main.cjs");
const { runHardenRunner } = require("./run.cjs");

function main({ env = process.env, run = runHardenRunner } = {}) {
  if (env.STATE_enforcement_disabled === "true") return;
  if (env.STATE_unsupported_platform === "true") return;
  // Harden Runner's pre-job entrypoint failed and the pre hook already warned;
  // its main entrypoint would fail the job for the same reason.
  if (env.STATE_start_failed === "true") return;
  if (env.STATE_inline_policy === "true") {
    run("main", null);
    return;
  }
  run("main", required("STATE_token", env));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { main };
