import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ACTIONS,
  checkWorkflow,
  checkWorkflows,
  discoverWorkflows,
  formatAnnotation,
  formatSummary,
  isActionManifest,
  isCheckerJob,
  isViolation,
  parseList,
  usesMatches,
} from "./check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const SECURE = "tempoxyz/gh-actions/actions/secure-runner@2b8d302bd3c5ca64e0cb14ae4b1a9fa0a4069500";

const workflow = (jobs) => `on: push\npermissions: {}\njobs:\n${jobs}`;
const job = (id, steps) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n${steps.map((s) => `      - ${s}\n`).join("")}`;

async function statuses(content, options) {
  const { findings } = await checkWorkflow({ name: "w.yml", content }, options);
  return Object.fromEntries(findings.map((f) => [f.job ?? "<workflow>", f.status]));
}

test("parseList splits on commas, whitespace and newlines", () => {
  assert.deepEqual(parseList(" a, b\nc  d ,,"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseList(undefined), []);
});

test("usesMatches ignores the ref unless the accepted entry pins one", () => {
  assert.equal(usesMatches(SECURE, DEFAULT_ACTIONS), true);
  assert.equal(usesMatches("tempoxyz/gh-actions/actions/secure-runner@main", DEFAULT_ACTIONS), true);
  assert.equal(usesMatches("tempoxyz/gh-actions/actions/harden-runner@main", DEFAULT_ACTIONS), false);
  assert.equal(usesMatches("tempoxyz/gh-actions/actions/secure-runner-extra@main", DEFAULT_ACTIONS), false);
  assert.equal(usesMatches("./actions/secure-runner", ["./actions/secure-runner"]), true);
  assert.equal(usesMatches(SECURE, [SECURE]), true);
  assert.equal(usesMatches("tempoxyz/gh-actions/actions/secure-runner@main", [SECURE]), false);
  assert.equal(usesMatches("", DEFAULT_ACTIONS), false);
});

test("a job whose first step is secure-runner passes", async () => {
  const content = workflow(job("build", [`uses: ${SECURE}`, "uses: actions/checkout@v4", "run: make"]));
  const { findings } = await checkWorkflow({ name: "w.yml", content });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, "ok");
  assert.equal(findings[0].job, "build");
  assert.equal(findings[0].uses, SECURE);
  assert.equal(findings[0].line, 4);
});

test("a job without secure-runner is a violation at the job line", async () => {
  const content = workflow(job("build", ["uses: actions/checkout@v4", "run: make"]));
  const { findings } = await checkWorkflow({ name: "w.yml", content });
  assert.equal(findings[0].status, "missing");
  assert.equal(findings[0].line, 4);
  assert.match(findings[0].detail, /first step is uses: actions\/checkout@v4/);
});

test("a job with no steps is a violation", async () => {
  const content = workflow("  build:\n    runs-on: ubuntu-latest\n    steps: []\n");
  assert.deepEqual(await statuses(content), { build: "missing" });
});

test("secure-runner that is not the first step is a violation at the step line", async () => {
  const content = workflow(job("build", ["uses: actions/checkout@v4", `uses: ${SECURE}`]));
  const { findings } = await checkWorkflow({ name: "w.yml", content });
  assert.equal(findings[0].status, "not-first");
  assert.equal(findings[0].line, 8);
  assert.match(findings[0].detail, /secure-runner is step 2; first step is uses: actions\/checkout@v4/);
});

test("a conditional secure-runner step is a violation, an explicit success() is not", async () => {
  const conditional = workflow(job("build", [`if: runner.os == 'Linux'\n        uses: ${SECURE}`, "run: make"]));
  const { findings } = await checkWorkflow({ name: "w.yml", content: conditional });
  assert.equal(findings[0].status, "conditional");
  assert.match(findings[0].detail, /runner\.os == 'Linux'/);
  const explicit = workflow(job("build", [`if: success()\n        uses: ${SECURE}`, "run: make"]));
  assert.deepEqual(await statuses(explicit), { build: "ok" });
});

test("reusable workflow calls are ok when resolved in the same scan and otherwise reported as reusable", async () => {
  const remote = workflow("  lint:\n    uses: tempoxyz/gh-actions/.github/workflows/rust-lint.yml@main\n");
  const report = await checkWorkflows([{ name: "w.yml", content: remote }]);
  assert.equal(report.ok, true);
  assert.equal(report.findings[0].status, "reusable");
  assert.match(report.findings[0].detail, /checked in the repository that defines that workflow/);
  assert.match(formatSummary(report), /### Reusable workflow calls not checked here/);

  const caller = workflow("  lint:\n    uses: ./.github/workflows/lint.yml\n");
  const callee = workflow(job("clippy", [`uses: ${SECURE}`]));
  const both = await checkWorkflows([
    { name: ".github/workflows/ci.yml", content: caller },
    { name: ".github/workflows/lint.yml", content: callee },
  ]);
  assert.equal(both.ok, true, JSON.stringify(both.violations));
  assert.equal(both.findings[0].status, "ok");
  assert.match(both.findings[0].detail, /checked in this scan/);

  const alone = await checkWorkflows([{ name: ".github/workflows/ci.yml", content: caller }]);
  assert.equal(alone.ok, true);
  assert.equal(alone.findings[0].status, "reusable");
  assert.match(alone.findings[0].detail, /not part of this scan/);
});

test("every status other than ok, reusable and checker is a violation", () => {
  for (const status of ["missing", "not-first", "conditional", "parse-error"]) {
    assert.equal(isViolation({ status }), true, status);
  }
  for (const status of ["ok", "reusable", "checker", "not-a-workflow"]) assert.equal(isViolation({ status }), false, status);
});

test("the job that only checks out and runs ensure-secure-runner is exempt, nothing else is", async () => {
  const ENSURE = "tempoxyz/gh-actions/actions/ensure-secure-runner@0123456789abcdef0123456789abcdef01234567";
  const checker = workflow(job("ensure", ["uses: actions/checkout@v4\n        with:\n          persist-credentials: false", `uses: ${ENSURE}`]));
  const { findings } = await checkWorkflow({ name: "w.yml", content: checker });
  assert.equal(findings[0].status, "checker");
  assert.equal(isViolation(findings[0]), false);

  assert.deepEqual(await statuses(workflow(job("local", ["uses: actions/checkout@v4", "uses: ./actions/ensure-secure-runner"]))), { local: "checker" });
  // Order and repetition of checkout do not matter; only the step set does.
  assert.deepEqual(await statuses(workflow(job("swap", [`uses: ${ENSURE}`, "uses: actions/checkout@v4"]))), { swap: "checker" });

  // Any other step, or the absence of the check itself, makes it an ordinary job.
  assert.deepEqual(await statuses(workflow(job("run", ["uses: actions/checkout@v4", `uses: ${ENSURE}`, "run: npm ci"]))), { run: "missing" });
  assert.deepEqual(await statuses(workflow(job("other", ["uses: actions/checkout@v4", "uses: actions/setup-node@v4", `uses: ${ENSURE}`]))), { other: "missing" });
  assert.deepEqual(await statuses(workflow(job("noself", ["uses: actions/checkout@v4"]))), { noself: "missing" });
  // With secure-runner first the job is simply ok.
  assert.deepEqual(await statuses(workflow(job("both", [`uses: ${SECURE}`, "uses: actions/checkout@v4", `uses: ${ENSURE}`]))), { both: "ok" });
  assert.equal(isCheckerJob([]), false);
});

test("action manifests among the scanned paths are skipped, not checked", async () => {
  const manifest = readFileSync(join(repoRoot, "actions", "secure-runner", "action.yml"), "utf8");
  assert.equal(isActionManifest(manifest), true);
  assert.equal(isActionManifest(workflow(job("a", ["run: make"]))), false);
  const report = await checkWorkflows([
    { name: "actions/secure-runner/action.yml", content: manifest },
    { name: ".github/workflows/ci.yml", content: workflow(job("a", [`uses: ${SECURE}`])) },
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.skipped, 1);
  assert.equal(report.workflows, 1);
  assert.equal(report.jobs, 1);
  assert.equal(report.findings[0].status, "not-a-workflow");
  assert.equal(isViolation(report.findings[0]), false);
});

test("unparseable and invalid workflows are violations", async () => {
  const broken = await checkWorkflow({ name: "w.yml", content: "on: push\njobs:\n  a:\n    steps: [\n" });
  assert.equal(broken.findings.length, 1);
  assert.equal(broken.findings[0].status, "parse-error");
  assert.equal(broken.findings[0].job, null);
  const invalid = await checkWorkflow({ name: "w.yml", content: workflow("  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: [1]\n") });
  assert.equal(invalid.findings[0].status, "parse-error");
  assert.equal(invalid.findings[0].line, 7);
});

test("accepted actions are configurable, including local paths and pinned refs", async () => {
  const content = workflow(job("a", ["uses: ./actions/secure-runner"]) + job("b", ["uses: tempoxyz/gh-actions/actions/secure-runner@main"]));
  assert.deepEqual(await statuses(content, { actions: ["./actions/secure-runner"] }), { a: "ok", b: "missing" });
  assert.deepEqual(await statuses(content, { actions: [SECURE] }), { a: "missing", b: "missing" });
  assert.deepEqual(await statuses(content, { actions: ["./actions/secure-runner", "tempoxyz/gh-actions/actions/secure-runner"] }), { a: "ok", b: "ok" });
});

test("checkWorkflows aggregates across files", async () => {
  const report = await checkWorkflows([
    { name: "a.yml", content: workflow(job("x", [`uses: ${SECURE}`]) + job("y", ["run: make"])) },
    { name: "b.yml", content: workflow("  call:\n    uses: o/r/.github/workflows/w.yml@main\n") },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.workflows, 2);
  assert.equal(report.jobs, 3);
  assert.deepEqual(report.violations.map((v) => [v.workflow, v.job, v.status]), [["a.yml", "y", "missing"]]);
});

test("annotations and summary are well formed", async () => {
  const report = await checkWorkflows([{ name: ".github/workflows/a.yml", content: workflow(job("y", ["run: make"])) }]);
  const annotation = formatAnnotation(report.violations[0]);
  assert.match(annotation, /^::error file=\.github\/workflows\/a\.yml,line=4,title=ensure-secure-runner::Job 'y': missing: /);
  assert.equal(annotation.includes("\n"), false);
  const summary = formatSummary(report);
  assert.match(summary, /❌ 1 violation\(s\)/);
  assert.match(summary, /\| `\.github\/workflows\/a\.yml` \| `y` \| 4 \| missing \|/);
});

test("discoverWorkflows expands directories (non-recursively), keeps files, dedupes and sorts", () => {
  const dir = mkdtempSync(join(tmpdir(), "csr-"));
  try {
    mkdirSync(join(dir, ".github", "workflows", "nested"), { recursive: true });
    for (const f of ["b.yml", "a.yaml", "README.md", "nested/c.yml"]) writeFileSync(join(dir, ".github", "workflows", f), "");
    writeFileSync(join(dir, "extra.yml"), "");
    assert.deepEqual(discoverWorkflows([".github/workflows", "extra.yml", ".github/workflows/b.yml"], dir), [
      ".github/workflows/a.yaml",
      ".github/workflows/b.yml",
      "extra.yml",
    ]);
    assert.throws(() => discoverWorkflows(["missing"], dir), /workflow path not found: missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every job in this repository's own workflows starts with secure-runner", async () => {
  const files = discoverWorkflows([".github/workflows"], repoRoot).map((name) => ({
    name,
    content: readFileSync(join(repoRoot, name), "utf8"),
  }));
  assert.ok(files.length > 0);
  const report = await checkWorkflows(files);
  assert.deepEqual(report.violations, []);
  assert.ok(report.findings.some((f) => f.status === "ok"));
});

function runMain(cwd, env) {
  const out = join(cwd, "output.txt");
  const summary = join(cwd, "summary.md");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  const result = spawnSync(process.execPath, [join(here, "main.mjs")], {
    cwd,
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, ...env },
    encoding: "utf8",
  });
  return { ...result, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
}

test("main.mjs fails on violations, emits annotations and outputs, and can be told not to fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "csr-main-"));
  try {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), workflow(job("good", [`uses: ${SECURE}`, "run: make"]) + job("bad", ["run: make"])));

    const failed = runMain(dir, {});
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /::error file=\.github\/workflows\/ci\.yml,line=9,title=ensure-secure-runner::Job 'bad': missing:/);
    assert.match(failed.stderr, /::error::ensure-secure-runner: 1 job\(s\) do not start/);
    assert.match(failed.output, /^count=1$/m);
    assert.match(failed.output, /^jobs=2$/m);
    assert.match(failed.output, /^workflows=1$/m);
    const violations = JSON.parse(failed.output.match(/^violations=(.*)$/m)[1]);
    assert.deepEqual(violations.map((v) => [v.workflow, v.job, v.line, v.status]), [[".github/workflows/ci.yml", "bad", 9, "missing"]]);
    assert.match(failed.summary, /## Secure runner check/);

    const soft = runMain(dir, { FAIL_ON_VIOLATION: "false" });
    assert.equal(soft.status, 0, soft.stdout + soft.stderr);
    assert.match(soft.stdout, /::warning::ensure-secure-runner: 1 job\(s\)/);

    const missingDir = runMain(dir, { WORKFLOWS: "nope" });
    assert.equal(missingDir.status, 1);
    assert.match(missingDir.stderr, /workflow path not found: nope/);

    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), workflow(job("good", [`uses: ${SECURE}`])));
    const clean = runMain(dir, {});
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.output, /^count=0$/m);
    assert.match(clean.output, /^violations=\[\]$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("action.yml wires the inputs main.mjs reads and the outputs it writes", () => {
  const action = readFileSync(join(here, "action.yml"), "utf8");
  assert.match(action, /using: "composite"/);
  assert.match(action, /node "\$GITHUB_ACTION_PATH\/main\.mjs"/);
  for (const env of ["WORKFLOWS: ${{ inputs.workflows }}", "ACTIONS: ${{ inputs.actions }}", "FAIL_ON_VIOLATION: ${{ inputs.fail-on-violation }}"]) {
    assert.ok(action.includes(env), `action.yml should set ${env}`);
  }
  for (const output of ["count", "jobs", "workflows", "violations"]) {
    assert.ok(action.includes(`\${{ steps.check.outputs.${output} }}`), `action.yml should expose output ${output}`);
  }
  assert.match(action, /default: "tempoxyz\/gh-actions\/actions\/secure-runner"/);
});

test("the committed parser bundle matches the version pinned in package.json", () => {
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  const version = pkg.dependencies["@actions/workflow-parser"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "pin an exact version so the bundle is reproducible");
  const header = readFileSync(join(here, "dist", "workflow-parser.cjs"), "utf8").slice(0, 300);
  assert.match(header, new RegExp(`@actions/workflow-parser ${version.replace(/\./g, "\\.")}, bundled by esbuild`));
  assert.deepEqual(readdirSync(join(here, "dist")), ["workflow-parser.cjs"]);
});
