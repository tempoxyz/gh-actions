const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("registers a post-job Aegis audit-log upload", () => {
  assert.match(manifest, /runs:\r?\n  using: "node24"\r?\n  main: "main\.cjs"\r?\n  post: "post\.cjs"/);
  const { aegisReportPath, artifactName } = require("./dist/artifact-upload.cjs");
  assert.equal(aegisReportPath("linux"), "/var/log/aegis/service.jsonl");
  assert.equal(aegisReportPath("darwin"), "/Library/Application Support/Aegis/service.jsonl");
  assert.equal(
    aegisReportPath("win32", { ProgramData: "C:\\ProgramData" }),
    "C:\\ProgramData\\Aegis\\service.jsonl",
  );
  assert.equal(
    artifactName("aegis-report", { GITHUB_JOB: "lint / check" }),
    "aegis-service-log-lint---check-aegis-report",
  );
  assert.match(fs.readFileSync(path.join(__dirname, "post.cjs"), "utf8"), /uploadAegisReport/);
});

test("post cleanup failures fail the job only on self-hosted runners", async () => {
  const { main: postMain } = require("./post.cjs");
  const failing = () => {
    throw new Error("aegis uninstall exited 1");
  };
  const run = (env) => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    return postMain({ upload: async () => {}, cleanup: failing, env, platform: "linux" })
      .finally(() => {
        console.log = original;
      })
      .then(() => lines);
  };

  const hosted = await run({ STATE_installation_identity: "abc", RUNNER_ENVIRONMENT: "github-hosted" });
  assert.deepEqual(hosted, [
    "::warning title=Aegis cleanup failed::aegis uninstall exited 1. This GitHub-hosted runner is discarded after the job.",
  ]);

  for (const environment of ["self-hosted", undefined]) {
    await assert.rejects(
      run({ STATE_installation_identity: "abc", ...(environment ? { RUNNER_ENVIRONMENT: environment } : {}) }),
      /aegis uninstall exited 1/,
      `cleanup must stay hard when RUNNER_ENVIRONMENT is ${environment}`,
    );
  }

  // Without an armed identity, or off Linux, cleanup does not run at all.
  let cleanups = 0;
  await postMain({
    upload: async () => {},
    cleanup: () => {
      cleanups += 1;
    },
    env: { RUNNER_ENVIRONMENT: "github-hosted" },
    platform: "linux",
  });
  await postMain({
    upload: async () => {},
    cleanup: () => {
      cleanups += 1;
    },
    env: { STATE_installation_identity: "abc" },
    platform: "darwin",
  });
  assert.equal(cleanups, 0);
});
