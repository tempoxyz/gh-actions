// Action entry point: read inputs from the environment, check every workflow, emit
// annotations, outputs and a step summary, and fail when a job is unprotected.
import { appendFileSync, readFileSync } from "node:fs";
import {
  DEFAULT_ACTIONS,
  DEFAULT_WORKFLOWS,
  checkWorkflows,
  discoverWorkflows,
  formatAnnotation,
  formatLine,
  formatSummary,
  parseList,
} from "./check.mjs";

const cwd = process.cwd();
const workflowPaths = parseList(process.env.WORKFLOWS);
const paths = workflowPaths.length ? workflowPaths : DEFAULT_WORKFLOWS;
const actionList = parseList(process.env.ACTIONS);
const actions = actionList.length ? actionList : DEFAULT_ACTIONS;
const failOnViolation = (process.env.FAIL_ON_VIOLATION ?? "true").trim().toLowerCase() !== "false";

let files;
try {
  files = discoverWorkflows(paths, cwd);
} catch (err) {
  console.error(`::error::ensure-secure-runner: ${err.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`::error::ensure-secure-runner: no workflow files found under ${paths.join(", ")}`);
  process.exit(1);
}

const report = await checkWorkflows(
  files.map((name) => ({ name, content: readFileSync(name, "utf8") })),
  { actions },
);

console.log(`checking ${report.jobs} job(s) in ${report.workflows} workflow(s) for a first step using ${actions.join(", ")}`);
for (const f of report.findings) console.log(formatLine(f));
for (const f of report.violations) console.log(formatAnnotation(f));

if (process.env.GITHUB_OUTPUT) {
  const violations = JSON.stringify(
    report.violations.map(({ workflow, job, line, status, detail }) => ({ workflow, job, line, status, detail })),
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [`count=${report.violations.length}`, `jobs=${report.jobs}`, `workflows=${report.workflows}`, `violations=${violations}`, ""].join("\n"),
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatSummary(report, { actions })}\n`);
}

if (report.ok) {
  const calls = report.findings.filter((f) => f.status === "reusable").length;
  const checkers = report.findings.filter((f) => f.status === "checker").length;
  const direct = report.jobs - calls - checkers;
  console.log(
    `no violations: ${direct} job(s) start with the secure-runner action` +
      (calls ? `, ${calls} reusable workflow call(s) are checked where they are defined` : "") +
      (checkers ? `, ${checkers} job(s) only run this check` : "") +
      (report.skipped ? `; ${report.skipped} action manifest(s) skipped` : ""),
  );
} else {
  const msg = `ensure-secure-runner: ${report.violations.length} job(s) do not start with the secure-runner action`;
  if (failOnViolation) {
    console.error(`::error::${msg}`);
    process.exit(1);
  }
  console.log(`::warning::${msg} (fail-on-violation is false)`);
}
