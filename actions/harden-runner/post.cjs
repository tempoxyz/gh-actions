const { main: revokeLease } = require("../step-security-sts/post.cjs");
const { runHardenRunner } = require("./run.cjs");

async function main() {
  const errors = [];
  const token = process.env.STATE_token || "";
  if (token !== "") {
    try {
      runHardenRunner("post", token);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await revokeLease();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Harden Runner cleanup failed");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
