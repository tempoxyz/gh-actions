const { main: revokeLease } = require("../step-security-sts/post.cjs");
const { runHardenRunner } = require("./run.cjs");

async function main({
  env = process.env,
  run = runHardenRunner,
  revoke = revokeLease,
} = {}) {
  const errors = [];
  const token = env.STATE_token || "";
  const inlinePolicy = env.STATE_inline_policy === "true";
  // Run the vendored post hook only when the pre hook started Harden Runner:
  // either with a minted policy-store key or with the inline-policy fallback.
  if (inlinePolicy || token !== "") {
    try {
      run("post", inlinePolicy ? null : token);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await revoke();
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
