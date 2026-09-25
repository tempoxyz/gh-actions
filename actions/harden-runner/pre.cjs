const {
  StsUnavailableError,
  append,
  exchangeToken,
  maskSecret,
  required,
} = require("../step-security-sts/main.cjs");
const { endpoint } = require("../step-security-sts/http.cjs");
const { runHardenRunner } = require("./run.cjs");

// GitHub state key recorded when Harden Runner runs without the policy store,
// either because a fork pull request received no OIDC token or because the
// Step Security STS could not issue a credential. The main and post
// entrypoints read it back as STATE_inline_policy.
const INLINE_POLICY_STATE = "inline_policy";
const ENFORCEMENT_DISABLED_STATE = "enforcement_disabled";
const UNSUPPORTED_PLATFORM_STATE = "unsupported_platform";

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

function escapeAnnotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function warning(message, title) {
  const properties =
    title === undefined
      ? ""
      : ` title=${escapeAnnotation(title).replaceAll(":", "%3A").replaceAll(",", "%2C")}`;
  console.log(`::warning${properties}::${escapeAnnotation(message)}`);
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
    );
    append(required("GITHUB_STATE", env), ENFORCEMENT_DISABLED_STATE, "true");
    return;
  }

  if (unsupportedPlatform(env)) {
    warning(
      "Harden Runner does not support Windows ARM64; skipping Harden Runner.",
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
    );
    append(required("GITHUB_STATE", env), INLINE_POLICY_STATE, "true");
    run("pre", null);
    return;
  }

  // Harden Runner reads the policy in its pre-job entrypoint. Mint the key in
  // this same pre-job process so it exists before that entrypoint starts.
  const host = stsHost(env["INPUT_STEP-SECURITY-STS-HOST"] || "ss-sts.tempoxyz.net");
  let result;
  try {
    result = await exchange(host);
  } catch (error) {
    // Only an availability failure degrades: the STS (or GitHub's OIDC issuer)
    // could not be reached, kept answering with transient errors through every
    // retry, or returned an unusable response. A definitive rejection means the
    // request is misconfigured and still fails the job. Without a credential,
    // Harden Runner applies the inline egress policy, which defaults to audit.
    if (!(error instanceof StsUnavailableError)) throw error;
    warning(
      `Could not obtain a StepSecurity policy-store credential from ${host} ` +
        `after retrying (${error.message}). Harden Runner is running in ` +
        `${inlineEgressPolicy(env)} mode from the workflow's inline egress ` +
        "policy, without the StepSecurity policy store, so stored egress " +
        "policies are not applied to this job.",
      "StepSecurity policy store unavailable",
    );
    append(required("GITHUB_STATE", env), INLINE_POLICY_STATE, "true");
    run("pre", null);
    return;
  }
  maskSecret(result.token);
  append(required("GITHUB_STATE", env), "token", result.token);
  append(required("GITHUB_STATE", env), "lease_id", result.leaseId);
  append(required("GITHUB_STATE", env), "sts_host", result.rawHost);
  run("pre", result.token);
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
  UNSUPPORTED_PLATFORM_STATE,
  enforcementDisabled,
  inlineEgressPolicy,
  inlinePolicyAllowed,
  main,
  oidcAvailable,
  unsupportedPlatform,
};
