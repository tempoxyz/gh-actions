const {
  append,
  exchangeToken,
  maskSecret,
  required,
} = require("../step-security-sts/main.cjs");
const { endpoint } = require("../step-security-sts/http.cjs");
const { warning } = require("./annotations.cjs");
const { runHardenRunner } = require("./run.cjs");

// GitHub state key recorded when Harden Runner runs without the policy store,
// either because a fork pull request received no OIDC token or because no
// Step Security STS credential could be obtained. The main and post
// entrypoints read it back as STATE_inline_policy.
const INLINE_POLICY_STATE = "inline_policy";
const ENFORCEMENT_DISABLED_STATE = "enforcement_disabled";
const UNSUPPORTED_PLATFORM_STATE = "unsupported_platform";
// Recorded when Harden Runner's own pre-job entrypoint exited non-zero. The
// main entrypoint then skips Harden Runner and the post entrypoint runs its
// cleanup best-effort.
const START_FAILED_STATE = "start_failed";

function stsHost(value = "ss-sts.tempoxyz.net") {
  return endpoint(value).audience;
}

function oidcAvailable(env = process.env) {
  return ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"].every(
    (name) => /^\S+$/.test(env[name] || ""),
  );
}

// GitHub never issues an OIDC token to pull_request runs from forks, whatever
// permissions the workflow declares. Only that event may fall back to the
// inline policy; anywhere else a missing token is a workflow misconfiguration.
function inlinePolicyAllowed(env = process.env) {
  return env.GITHUB_EVENT_NAME === "pull_request";
}

// The egress policy Harden Runner applies when it runs without the policy
// store. It mirrors the vendored action's egress-policy input default.
function inlineEgressPolicy(env = process.env) {
  return env["INPUT_EGRESS-POLICY"] || "audit";
}

function unsupportedPlatform(env = process.env) {
  return env.RUNNER_OS === "Windows" && env.RUNNER_ARCH === "ARM64";
}

function enforcementDisabled(env = process.env) {
  const value = env["INPUT_DISABLE-ENFORCEMENT"] || "false";
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("disable-enforcement must be true or false");
}

// Starts Harden Runner's vendored pre-job entrypoint. Its failure degrades the
// job instead of failing it. The vendored code reports its own errors as
// annotations and exits zero even then, but a crash, a future upstream change,
// or a runner missing a prerequisite must not halt CI either. The job then runs
// without Harden Runner, which the warning says plainly.
function startHardenRunner(run, token, env) {
  try {
    run("pre", token);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warning(
      `Harden Runner did not start (${reason}). This job is running without ` +
        "Harden Runner's runtime monitoring and egress enforcement.",
      "Harden Runner unavailable",
      env,
    );
    append(required("GITHUB_STATE", env), START_FAILED_STATE, "true");
  }
}

async function main({
  env = process.env,
  run = runHardenRunner,
  exchange = exchangeToken,
} = {}) {
  if (enforcementDisabled(env)) {
    warning(
      "Runner security enforcement was explicitly disabled for this job; " +
        "Harden Runner will not start.",
      undefined,
      env,
    );
    append(required("GITHUB_STATE", env), ENFORCEMENT_DISABLED_STATE, "true");
    return;
  }

  if (unsupportedPlatform(env)) {
    warning(
      "Harden Runner does not support Windows ARM64; skipping Harden Runner.",
      undefined,
      env,
    );
    append(required("GITHUB_STATE", env), UNSUPPORTED_PLATFORM_STATE, "true");
    return;
  }

  if (!oidcAvailable(env)) {
    if (!inlinePolicyAllowed(env)) {
      throw new Error(
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing: the job must grant " +
          "`id-token: write` so Harden Runner can fetch its StepSecurity " +
          `policy-store credential (event: ${env.GITHUB_EVENT_NAME || "unknown"})`,
      );
    }
    warning(
      "GitHub issued no OIDC token to this pull_request run (fork pull " +
        "requests never receive one). Harden Runner is running with the " +
        "workflow's inline egress policy instead of the StepSecurity policy store.",
      undefined,
      env,
    );
    append(required("GITHUB_STATE", env), INLINE_POLICY_STATE, "true");
    startHardenRunner(run, null, env);
    return;
  }

  // Harden Runner reads the policy in its pre-job entrypoint. Mint the key in
  // this same pre-job process so it exists before that entrypoint starts. The
  // hostname is validated here, before any request, so a bad input still
  // fails the job.
  const host = stsHost(env["INPUT_STEP-SECURITY-STS-HOST"] || "ss-sts.tempoxyz.net");
  let result;
  try {
    result = await exchange(host);
  } catch (error) {
    // Any failure to obtain the credential degrades instead of failing the
    // job: the STS or GitHub's OIDC issuer was unreachable, kept answering
    // with transient errors through every retry, exceeded its rate-limit wait
    // budget, returned an unusable response, or rejected the exchange
    // outright. Without a credential, Harden Runner applies the inline egress
    // policy, which defaults to audit.
    const reason = error instanceof Error ? error.message : String(error);
    warning(
      `Could not obtain a StepSecurity policy-store credential from ${host}: ` +
        `${reason}. Harden Runner is running in ${inlineEgressPolicy(env)} ` +
        "mode from the workflow's inline egress policy, without the " +
        "StepSecurity policy store, so stored egress policies are not " +
        "applied to this job.",
      "StepSecurity policy store unavailable",
      env,
    );
    append(required("GITHUB_STATE", env), INLINE_POLICY_STATE, "true");
    startHardenRunner(run, null, env);
    return;
  }
  maskSecret(result.token);
  append(required("GITHUB_STATE", env), "token", result.token);
  append(required("GITHUB_STATE", env), "lease_id", result.leaseId);
  append(required("GITHUB_STATE", env), "sts_host", result.rawHost);
  startHardenRunner(run, result.token, env);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ENFORCEMENT_DISABLED_STATE,
  INLINE_POLICY_STATE,
  START_FAILED_STATE,
  UNSUPPORTED_PLATFORM_STATE,
  enforcementDisabled,
  inlineEgressPolicy,
  inlinePolicyAllowed,
  main,
  oidcAvailable,
  unsupportedPlatform,
};
