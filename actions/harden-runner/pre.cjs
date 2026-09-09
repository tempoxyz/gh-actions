const {
  append,
  exchangeToken,
  maskSecret,
  required,
} = require("../step-security-sts/main.cjs");
const { runHardenRunner } = require("./run.cjs");

// GitHub state key recorded when Harden Runner runs without the policy store.
// The main and post entrypoints read it back as STATE_inline_policy.
const INLINE_POLICY_STATE = "inline_policy";

function stsEndpoint(dev = process.env.INPUT_DEV || "false") {
  if (dev === "true") return "https://ss-sts.tehq.dev";
  if (dev === "false") return "https://ss-sts.tehq.net";
  throw new Error("dev must be true or false");
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

function warning(message) {
  const escaped = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.log(`::warning::${escaped}`);
}

async function main({
  env = process.env,
  run = runHardenRunner,
  exchange = exchangeToken,
} = {}) {
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
  const result = await exchange(stsEndpoint(env.INPUT_DEV || "false"));
  maskSecret(result.token);
  append(required("GITHUB_STATE", env), "token", result.token);
  append(required("GITHUB_STATE", env), "lease_id", result.leaseId);
  append(required("GITHUB_STATE", env), "sts_url", result.rawEndpoint);
  run("pre", result.token);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { INLINE_POLICY_STATE, inlinePolicyAllowed, main, oidcAvailable };
