const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

test("post skips teardown only on explicitly GitHub-hosted runners", async () => {
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
  assert.deepEqual(hosted, []);

  for (const environment of ["self-hosted", undefined, "", "unknown"]) {
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

test("post annotates runtime warning decisions without duplicating lookup diagnostics", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-report-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const copiedLog = path.join(temp, "aegis-service.jsonl");
  const summary = path.join(temp, "summary.md");
  const records = [
    { msg: "socket lookup complete", action: "warn", result: "warn" },
    { msg: "package decision", action: "allow", reason: "allowed" },
    { msg: "package decision", action: "warn", reason: "Not connected to internet" },
    { msg: "package decision", action: "warn", reason: "upstream\n::error::secret" },
    null,
  ];
  const { main: postMain } = require("./post.cjs");
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await postMain({
      upload: async () => fs.writeFileSync(copiedLog, records.map(JSON.stringify).join("\n") + "\nnot JSON\n"),
      env: { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary },
      platform: "linux",
    });
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, [
    "::warning title=Aegis runtime warning verdicts::Aegis allowed 2 package downloads with warning verdicts: Not connected to internet (1), other warning verdicts (1). Review the Aegis audit-log artifact for details.",
  ]);
  assert.match(fs.readFileSync(summary, "utf8"), /Not connected to internet/);
  assert.doesNotMatch(fs.readFileSync(summary, "utf8"), /secret/);
});

test("post still reports copied warning verdicts when artifact upload fails", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-upload-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await require("./post.cjs").main({
      upload: async () => {
        fs.writeFileSync(path.join(temp, "aegis-service.jsonl"), '{"msg":"package decision","action":"warn","reason":"Aegis server unreachable"}\n');
        throw new Error("artifact service unavailable");
      },
      env: { RUNNER_TEMP: temp },
      platform: "linux",
    });
  } finally {
    console.log = original;
  }
  assert.match(lines[0], /Aegis audit-log upload failed::artifact service unavailable/);
  assert.match(lines[1], /Aegis runtime warning verdicts::.*Aegis server unreachable \(1\)/);
});
