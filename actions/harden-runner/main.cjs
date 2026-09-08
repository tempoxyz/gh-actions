const { required } = require("../step-security-sts/main.cjs");
const { runHardenRunner } = require("./run.cjs");

function main() {
  runHardenRunner("main", required("STATE_token"));
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
