const hardenRunnerPost = require("../harden-runner/post.cjs");
const stepSecurityPost = require("../step-security-sts/post.cjs");
const socketPost = require("../socket-sts/post.cjs");
const aegisPost = require("../aegis-report/post.cjs");
const { retireProvider } = require("../aegis/token-provider.cjs");

// Snapshot/upload the audit log alongside bounded Aegis quiescing on hosted
// runners (full retirement elsewhere). Then Socket revocation and telemetry
// flush overlap each other and the upload. The StepSecurity lease stays alive
// until its flush finishes. Drain every branch, including after failures.
async function main({ env = process.env, platform = process.platform, hooks = {} } = {}) {
  const {
    aegis = aegisPost.report,
    retire = aegisPost.cleanup,
    socket = socketPost.main,
    hardenRunner = hardenRunnerPost.main,
    revokeLease = stepSecurityPost.main,
    stopProvider = retireProvider,
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

  const aegisOptions = {
    env: {
      ...env,
      STATE_action: env.STATE_aegis_action,
      STATE_installation_identity: env.STATE_aegis_installation_identity || "",
    },
    platform,
  };
  // The report hook copies the log before yielding; teardown cannot remove the
  // source out from under the snapshot, and uploads use GitHub credentials.
  const reporting = env.STATE_aegis_action
    ? attempt("Aegis reporting", () => aegis(aegisOptions)) : Promise.resolve();
  const retiring = env.STATE_aegis_action
    ? attempt("Aegis cleanup", () => retire(aegisOptions)) : Promise.resolve();
  const providerTokens = env.STATE_socket_provider_url
    ? Promise.resolve().then(() => stopProvider(env.STATE_socket_provider_url)).catch(() => {
      console.log("::warning title=Socket credential cleanup incomplete::Could not collect replacement Socket tokens; their STS lease expiry still bounds their lifetime.");
      return [];
    }) : undefined;
  await Promise.all([reporting, retiring.then(async () => {
    await Promise.all([
      (async () => {
        const tokens = new Set([env.STATE_socket_token, ...(providerTokens ? await providerTokens : [])].filter(Boolean));
        await Promise.all([...tokens].map((token) => attempt("Socket token revocation", () =>
          socket({
            env: {
              ...env,
              STATE_token: token,
              STATE_host: env.STATE_socket_host || "",
              STATE_upload_aegis_report: "false",
            },
          }))));
      })(),
      attempt("Harden Runner cleanup", () =>
        hardenRunner({ env, run, revoke: () => revokeLease({ env }) })),
    ]);
  })]);

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
