const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("registers a post-job Aegis audit-log upload", () => {
  assert.match(manifest, /runs:\r?\n  using: "node24"\r?\n  main: "main\.cjs"\r?\n  post: "post\.cjs"/);
  const {
    aegisReportExists,
    aegisReportPath,
    artifactName,
  } = require("./dist/artifact-upload.cjs");
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
  const sudoCalls = [];
  assert.equal(
    aegisReportExists("/var/log/aegis/service.jsonl", "linux", (...args) => sudoCalls.push(args)),
    true,
  );
  assert.deepEqual(sudoCalls, [["sudo", ["test", "-f", "/var/log/aegis/service.jsonl"], { stdio: "ignore" }]]);
  assert.equal(aegisReportExists("/var/log/aegis/missing.jsonl", "linux", () => {
    throw new Error("missing");
  }), false);
  assert.match(fs.readFileSync(path.join(__dirname, "post.cjs"), "utf8"), /uploadAegisReport/);
});
