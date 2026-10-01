const fs = require("node:fs");
const path = require("node:path");
const { aegisReportPath, uploadAegisReport } = require("./dist/artifact-upload.cjs");
const { stepSummary, warning } = require("../harden-runner/annotations.cjs");
const { retireAsync } = require("./linux-lifecycle.cjs");
const { scanRuntimeWarnings, runtimeWarningMessage } = require("./runtime-warnings.cjs");

function workflowEventsUrl(env) {
  const repository = env.GITHUB_REPOSITORY?.split("/");
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  if (repository?.length !== 2 || repository.some((part) => !part)
      || !/^[1-9][0-9]*$/.test(runId || "") || !/^[1-9][0-9]*$/.test(runAttempt || "")) return "";
  return `https://go/aegis/${repository.map(encodeURIComponent).join("/")}/workflows/${runId}/${runAttempt}`;
}

async function report({
  upload = uploadAegisReport,
  scan = scanRuntimeWarnings,
  env = process.env,
  platform = process.platform,
} = {}) {
  try {
    const uploadStarted = Date.now();
    try {
      await upload({ action: env.STATE_action || "aegis-report", env });
    } catch (error) {
      warning(error.message, "Aegis audit-log upload failed", env);
    }
    // The uploader makes a readable copy of the root-owned Linux service log
    // before contacting GitHub. Scan it even if the artifact upload failed.
    const source = aegisReportPath(platform, env);
    const copiedLog = path.join(env.RUNNER_TEMP || path.dirname(source), "aegis-service.jsonl");
    try {
      // Ignore a copy left by an earlier job on a reused runner.
      if (fs.existsSync(copiedLog) && fs.statSync(copiedLog).mtimeMs >= uploadStarted - 1000) {
        const decisions = await scan(copiedLog);
        const message = runtimeWarningMessage(decisions);
        if (message) warning(message, "Aegis runtime warning verdicts", env);
        if (decisions.blocked) {
          stepSummary(env, `> ⛔ **Aegis blocked package downloads:** Aegis blocked ${decisions.blocked} package download${decisions.blocked === 1 ? "" : "s"}. Review the Aegis audit-log artifact for details.`);
        }
        if (message || decisions.blocked) {
          const url = workflowEventsUrl(env);
          if (url) stepSummary(env, `\n[View all events for this workflow in Aegis](${url})`);
        }
      }
    } catch (error) {
      warning(error.message, "Aegis warning reporting failed", env);
    }
  } catch (error) {
    warning(error.message, "Aegis post-job reporting failed", env);
  }
}

async function cleanup({ env = process.env, platform = process.platform, cleanup: retire = retireAsync } = {}) {
  // Unknown environments are potentially persistent: only explicitly hosted
  // runners may leave their installation for GitHub to discard with the VM.
  if (platform === "linux" && env.STATE_installation_identity && env.RUNNER_ENVIRONMENT !== "github-hosted") {
    await retire({ expectedIdentity: env.STATE_installation_identity });
  }
}

async function main(options = {}) {
  // uploadAegisReport snapshots the log synchronously before its first await.
  // Retire in a child process so upload traffic continues during uninstall.
  const results = await Promise.allSettled([report(options), cleanup(options)]);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Aegis post-job cleanup failed");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, report, cleanup };
