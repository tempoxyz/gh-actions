const hardenRunnerPost = require("../harden-runner/post.cjs");
const stepSecurityPost = require("../step-security-sts/post.cjs");
const socketPost = require("../socket-sts/post.cjs");
const githubPost = require("../github-sts/post.js");
const aegisPost = require("../aegis-report/post.cjs");

// Job end. The cleanups run in the reverse of the order their pieces started,
// as the nested actions' post hooks did: the Aegis audit log uploads and the
// Linux installation retires before the Socket token that fed it is revoked,
// and Harden Runner stops last. One state file holds every piece's state under
// its own prefix; each hook sees the `STATE_*` names it expects. Every cleanup
// runs even if an earlier one fails, and failures are reported together.
async function main({ env = process.env, platform = process.platform, hooks = {} } = {}) {
  const {
    aegis = aegisPost.main,
    github = githubPost.main,
    socket = socketPost.main,
    hardenRunner = hardenRunnerPost.main,
    revokeLease = stepSecurityPost.main,
    run,
  } = hooks;
  const errors = [];
  const attempt = async (label, cleanup) => {
    try {
      await cleanup();
    } catch (error) {
      errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };

  if (env.STATE_aegis_action) {
    await attempt("Aegis cleanup", () =>
      aegis({
        env: {
          ...env,
          STATE_action: env.STATE_aegis_action,
          STATE_installation_identity: env.STATE_aegis_installation_identity || "",
        },
        platform,
      }));
  }
  if (env.STATE_github_token) {
    await attempt("GitHub App token revocation", () =>
      github({
        env: { ...env, STATE_token: env.STATE_github_token, STATE_sts_host: env.STATE_github_sts_host || "" },
      }));
  }
  if (env.STATE_socket_token) {
    await attempt("Socket token revocation", () =>
      socket({
        env: {
          ...env,
          STATE_token: env.STATE_socket_token,
          STATE_host: env.STATE_socket_host || "",
          STATE_upload_aegis_report: "false",
        },
      }));
  }
  await attempt("Harden Runner cleanup", () =>
    hardenRunner({ env, run, revoke: () => revokeLease({ env }) }));

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Secure Runner cleanup failed");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
