const { main: revokeLease } = require("../step-security-sts/post.cjs");
const { warning } = require("./annotations.cjs");
const { runHardenRunner } = require("./run.cjs");

async function main({
  env = process.env,
  run = runHardenRunner,
  revoke = revokeLease,
} = {}) {
  if (env.STATE_enforcement_disabled === "true") return;
  if (env.STATE_unsupported_platform === "true") return;
  const errors = [];
  const token = env.STATE_token || "";
  const inlinePolicy = env.STATE_inline_policy === "true";
  const startFailed = env.STATE_start_failed === "true";
  // Run the vendored post hook whenever the pre hook attempted to start Harden
  // Runner, with a minted policy-store key or the inline-policy fallback. After
  // a failed start it runs best-effort: it may stop a half-started agent, but
  // its own failure must not turn a job that already ran unprotected red.
  if (inlinePolicy || token !== "") {
    try {
      run("post", inlinePolicy ? null : token);
    } catch (error) {
      if (!startFailed) errors.push(error);
      else {
        warning(
          "Harden Runner post-job cleanup failed after Harden Runner did not " +
            `start (${error instanceof Error ? error.message : String(error)}).`,
          "Harden Runner unavailable",
        );
      }
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
