const { required } = require("../step-security-sts/main.cjs");
const { runHardenRunner } = require("./run.cjs");

function main({ env = process.env, run = runHardenRunner } = {}) {
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
