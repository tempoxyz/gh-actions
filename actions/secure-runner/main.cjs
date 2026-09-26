const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { append, maskSecret, required } = require("../step-security-sts/main.cjs");
const { warning } = require("../harden-runner/annotations.cjs");
const { enforcementDisabled, oidcAvailable } = require("../harden-runner/pre.cjs");
const socketSts = require("../socket-sts/main.cjs");
const { host: socketHost } = require("../socket-sts/http.cjs");
const githubSts = require("../github-sts/main.js");
const { downloadAndVerify } = require("../aegis/download.cjs");
const { installAegis, retrying, runCommand } = require("../aegis/install.cjs");
const { prepareConfiguration } = require("../aegis/token-provider.cjs");
const { runnerOIDCEnvironment } = require("../aegis/github-oidc.cjs");
const { identity, retire } = require("../aegis-report/linux-lifecycle.cjs");
const { createOidcClient } = require("./oidc.cjs");

const GITHUB_STS_HOST = "gh-sts.tempoxyz.net";
const AEGIS_RELEASE_SCOPE = "tempoxyz/aegis";
const AEGIS_RELEASE_POLICY = "download-releases";
const AEGIS_RELEASE_TOKEN_TTL = "15m";
const TITLE = "Package-policy enforcement disabled";

// Stage descriptions, worded as the Aegis composite's status report words them
// so existing checks on the annotation keep matching.
const STAGES = {
  socket: "the Socket STS did not issue a Socket API token",
  release: "the GitHub STS did not issue an Aegis release download token",
  cli: "a GitHub CLI with attestation support could not be bootstrapped",
  download: "the Aegis release could not be downloaded and verified",
  provider: "the Aegis token provider could not be started",
  lifecycle: "the Aegis lifecycle handler could not be prepared",
  install: "the Aegis package could not be installed",
};

class StageError extends Error {
  constructor(reason, cause) {
    super(`${reason}: ${cause.message}`, { cause });
    this.name = "StageError";
    this.reason = reason;
  }
}

async function stage(reason, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new StageError(reason, error instanceof Error ? error : new Error(String(error)));
  }
}

function eventPayload(env) {
  try {
    return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

// GitHub never issues an OIDC token to pull_request runs from forks, whatever
// permissions the workflow declares. Only that case may run without a firewall.
function forkPullRequest(env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return false;
  const head = eventPayload(env).pull_request?.head?.repo?.full_name;
  return typeof head === "string" && head !== "" && head !== env.GITHUB_REPOSITORY;
}

// Runs the checksum-pinned GitHub CLI bootstrap and returns the PATH entries
// it published through GITHUB_PATH. Those only reach later steps on their own;
// this process must add them itself before calling `gh`.
async function ensureGitHubCli({ env, token, spawn = spawnSync, sleep }) {
  const script = path.join(__dirname, "..", "setup-foundry", "ensure-gh.sh");
  const pathFile = env.GITHUB_PATH;
  const before = pathFile && fs.existsSync(pathFile) ? fs.statSync(pathFile).size : 0;
  await retrying(
    "GitHub CLI bootstrap",
    () => runCommand(spawn, "bash", [script], { env: { ...env, GH_TOKEN: token } }),
    { sleep },
  );
  if (!pathFile || !fs.existsSync(pathFile)) return [];
  return fs.readFileSync(pathFile, "utf8").slice(before).split(/\r?\n/).filter(Boolean);
}

// Returns a provider for one audience that serves the warmed assertion first
// and a fresh one on every later call, which is what both STS clients expect
// after a consumed assertion.
function assertionProvider(oidc, audience) {
  let first = true;
  return () => {
    const fresh = !first;
    first = false;
    return oidc.token(audience, { fresh });
  };
}

async function main({ env = process.env, platform = process.platform, deps = {} } = {}) {
  const {
    spawn = spawnSync,
    sleep,
    oidc = createOidcClient({ env }),
    exchangeSocket = socketSts.exchange,
    exchangeGitHub = githubSts.exchange,
    ensureCli = ensureGitHubCli,
    download = downloadAndVerify,
    prepareConfig = prepareConfiguration,
    readIdentity = identity,
    retireIncumbent = retire,
    install = installAegis,
  } = deps;

  if (enforcementDisabled(env)) {
    console.log("Runner security enforcement is disabled for this job; Aegis will not be installed.");
    return;
  }
  if (!oidcAvailable(env)) {
    if (forkPullRequest(env)) {
      warning(
        "This job is running for a fork pull request, which receives no GitHub OIDC token. " +
          "No package firewall will be installed; downloads will not be inspected or blocked.",
        TITLE,
        env,
      );
      return;
    }
    throw new Error(
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing: the job must grant id-token: write " +
        `(event: ${env.GITHUB_EVENT_NAME || "unknown"})`,
    );
  }

  const state = required("GITHUB_STATE", env);
  const socketEndpoint = socketHost(env["INPUT_SOCKET-STS-HOST"] || "socket-sts.tempoxyz.net");

  // Both assertions are requested at once; the exchanges below still run in
  // order, so nothing is downloaded or installed without a Socket API token.
  oidc.token(socketEndpoint).catch(() => {});
  oidc.token(GITHUB_STS_HOST).catch(() => {});

  try {
    const socket = await stage(STAGES.socket, () =>
      exchangeSocket({ endpoint: socketEndpoint, getAssertion: assertionProvider(oidc, socketEndpoint), sleep }));
    maskSecret(socket.token);
    append(state, "socket_token", socket.token);
    append(state, "socket_host", socketEndpoint);

    const release = await stage(STAGES.release, () =>
      exchangeGitHub({
        host: GITHUB_STS_HOST,
        scope: AEGIS_RELEASE_SCOPE,
        policy: AEGIS_RELEASE_POLICY,
        ttl: AEGIS_RELEASE_TOKEN_TTL,
        getOidc: assertionProvider(oidc, GITHUB_STS_HOST),
      }));
    maskSecret(release.token);
    append(state, "github_token", release.token);
    append(state, "github_sts_host", GITHUB_STS_HOST);

    const pathEntries = await stage(STAGES.cli, () => ensureCli({ env, token: release.token, spawn, sleep }));
    const artifact = await stage(STAGES.download, () =>
      download({ token: release.token, runnerOS: env.RUNNER_OS, runnerArch: env.RUNNER_ARCH, env, pathEntries, sleep }));
    const config = await stage(STAGES.provider, () =>
      prepareConfig(socket.token, { env, oidc: runnerOIDCEnvironment(env) }));

    // Register the log upload before installing, so a failed install still
    // uploads what Aegis logged. On Linux, retire any managed installation an
    // earlier job on this runner left behind, then arm cleanup for this one.
    await stage(STAGES.lifecycle, async () => {
      append(state, "aegis_action", env.GITHUB_ACTION || "secure-runner");
      if (platform === "linux") {
        const owner = await readIdentity(JSON.parse(fs.readFileSync(config, "utf8")));
        await retireIncumbent();
        append(state, "aegis_installation_identity", owner);
      }
    });

    const installed = await stage(STAGES.install, () =>
      install({ platform, packagePath: artifact.package, configPath: config, env, spawn, sleep }));
    console.log(`Aegis installed at ${installed.binary}; package downloads are inspected and enforced.`);
  } catch (error) {
    if (!(error instanceof StageError)) throw error;
    // Any failure to set the firewall up leaves the job running without one
    // rather than failing it; the annotation names the stage and the error.
    warning(
      `Aegis was not installed: ${error.reason} (${error.cause.message}). ` +
        "No package firewall is running for this job, so package downloads are not inspected or blocked.",
      TITLE,
      env,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  AEGIS_RELEASE_POLICY,
  AEGIS_RELEASE_SCOPE,
  AEGIS_RELEASE_TOKEN_TTL,
  GITHUB_STS_HOST,
  STAGES,
  StageError,
  assertionProvider,
  ensureGitHubCli,
  forkPullRequest,
  main,
};
