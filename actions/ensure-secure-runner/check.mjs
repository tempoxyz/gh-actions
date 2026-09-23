// Decide, for every job in a set of workflow files, whether it starts with the secure-runner
// action. Pure logic (no process state) so it can be unit-tested; main.mjs wires it to the
// action's inputs and outputs.
//
// Workflows are parsed with @actions/workflow-parser (GitHub's own parser, bundled into
// dist/workflow-parser.cjs by build.mjs) rather than plain YAML so that job/step structure,
// reusable-workflow calls and `if:` normalization match what the Actions service does.
//
// Exceptions are either structurally verified status-only jobs or exact, reasoned opt-ins.
import { readdirSync, statSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import {
  parseWorkflow,
  convertWorkflowTemplate,
  NoOperationTraceWriter,
  ErrorPolicy,
} from "./dist/workflow-parser.cjs";

export const DEFAULT_ACTIONS = ["tempoxyz/gh-actions/actions/secure-runner"];
export const DEFAULT_WORKFLOWS = [".github/workflows"];

// The job that runs this check does not itself need secure-runner: it only checks out the
// repository and reads workflow files. To keep that from becoming a loophole, the exemption
// applies only when every step of the job is one of these actions.
export const SELF_ACTIONS = [
  "tempoxyz/gh-actions/actions/ensure-secure-runner",
  "./actions/ensure-secure-runner",
];
export const CHECKOUT_ACTIONS = ["actions/checkout"];

// Reviewed implementations that only inspect needs results; new revisions require review.
export const STATUS_ACTIONS = [
  "tempoxyz/gh-actions/actions/check-needs@117919c943b804057be733b0c4034c5542e58959",
  "re-actors/alls-green@b5b5b37504aa4183270bd3d855c52a67f212be35",
];

// Every status a finding can have. Only the PASSING ones do not fail the check.
export const STATUSES = ["ok", "reusable", "checker", "status-only", "exempt", "not-a-workflow", "missing", "not-first", "conditional", "parse-error"];
export const PASSING = new Set(["ok", "reusable", "checker", "status-only", "exempt", "not-a-workflow"]);

export function parseExemptions(value = "{}") {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("exemptions must be a JSON object mapping workflow-file:job-id to a reason"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("exemptions must be a JSON object");
  }
  for (const [key, reason] of Object.entries(parsed)) {
    const path = key.split(":")[0];
    if (!/^[A-Za-z0-9_./-]+\.ya?ml:[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ||
        path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`invalid exemption ${JSON.stringify(key)}: use an exact repository-relative workflow-file:job-id (no wildcards)`);
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Error(`exemption ${JSON.stringify(key)} requires a non-empty reason`);
    }
  }
  return new Map(Object.entries(parsed).map(([key, reason]) => [key, reason.trim()]));
}

function mappingValue(token, key) {
  return token?.type === 2 ? [...token].find((pair) => scalarText(pair.key) === key)?.value : undefined;
}

function onlyKeys(token, keys) {
  return token?.type === 2 && [...token].every((pair) => keys.includes(scalarText(pair.key)));
}

// Inspect raw tokens: conversion intentionally omits permissions and some other fields.
// Only these literal Rust settings are harmless to the reviewed Node/Python status actions.
const STATUS_ENV = { CARGO_TERM_COLOR: ["always", "never", "auto"], RUST_BACKTRACE: ["full", "0", "1"], RUSTC_WRAPPER: ["sccache"] };
function isStatusEnvironment(env) {
  return !env || (env.type === 2 && [...env].every(({ key, value }) =>
    value.type === 0 && Object.hasOwn(STATUS_ENV, scalarText(key)) && STATUS_ENV[scalarText(key)].includes(scalarText(value))));
}

function isStatusOnlyJob(root, rawJob, steps) {
  const permissions = mappingValue(rawJob, "permissions");
  if (permissions?.type !== 2 || permissions.count !== 0 || steps.length !== 1) return false;
  if (!isStatusEnvironment(mappingValue(root, "env")) || mappingValue(root, "defaults")) return false;
  if (!onlyKeys(rawJob, ["name", "needs", "if", "runs-on", "permissions", "steps", "timeout-minutes"])) return false;
  const rawStep = mappingValue(rawJob, "steps")?.get(0);
  if (!onlyKeys(rawStep, ["name", "id", "uses", "with"])) return false;
  const inputs = mappingValue(rawStep, "with");
  if (inputs && !onlyKeys(inputs, ["jobs", "allowed-skips", "allowed-failures"])) return false;
  return STATUS_ACTIONS.includes(scalarText(steps[0].uses));
}

// Only workflows are checked. Composite and JavaScript actions are called from workflow jobs
// that already start with secure-runner, so an action manifest (top-level `runs:` and no
// `jobs:`) that ends up among the scanned paths is skipped rather than reported.
export function isActionManifest(content) {
  return /^runs:\s*(#.*)?$/m.test(content) && !/^jobs:\s*(#.*)?$/m.test(content);
}
export const isViolation = (finding) => !PASSING.has(finding.status);

// Split a comma, whitespace or newline separated list.
export function parseList(value) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Does a step's `uses:` value refer to one of the accepted actions? Entries without an `@ref`
// match any ref of that action; entries with one require that exact ref.
export function usesMatches(uses, accepted) {
  const target = (uses ?? "").trim();
  if (!target) return false;
  for (const entry of accepted) {
    if (entry.includes("@")) {
      if (target === entry) return true;
      continue;
    }
    const at = target.indexOf("@");
    if ((at === -1 ? target : target.slice(0, at)) === entry) return true;
  }
  return false;
}

// Expand files and directories into a sorted, deduplicated list of workflow paths relative to
// cwd. Directories are not recursed, matching how GitHub discovers workflows.
export function discoverWorkflows(paths, cwd = process.cwd()) {
  const found = new Set();
  for (const p of paths) {
    const abs = resolve(cwd, p);
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`workflow path not found: ${p}`);
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.add(join(abs, entry.name));
      }
    } else {
      found.add(abs);
    }
  }
  return [...found].map((abs) => relative(cwd, abs).split("\\").join("/")).sort();
}

function scalarText(token) {
  if (!token) return "";
  if (typeof token.value === "string") return token.value;
  return token.toString?.() ?? "";
}

function describeStep(step) {
  if (!step) return "no steps";
  if (step.uses) return `uses: ${scalarText(step.uses)}`;
  if (step.run) {
    const first = scalarText(step.run).split("\n").find((l) => l.trim()) ?? "";
    const line = first.trim();
    return `run: ${line.length > 60 ? `${line.slice(0, 57)}...` : line}`;
  }
  if (step.parallel) return "a parallel block";
  return `step ${step.id}`;
}

// A reusable-workflow call has no steps of its own. When it calls a workflow in this repository
// (`./.github/workflows/x.yml`) that is part of the same scan it is "ok", because that
// workflow's jobs are checked individually. Otherwise it is "reusable": allowed, since the
// called workflow's jobs are checked in the repository that defines it, but reported so the
// gap in coverage is visible.
function normalizeLocalRef(ref) {
  const path = ref.replace(/@.*$/, "");
  return path.startsWith("./") ? path.slice(2) : null;
}

// A job consisting solely of checkout step(s) and the ensure-secure-runner action.
export function isCheckerJob(steps) {
  if (!steps.length) return false;
  let self = false;
  for (const step of steps) {
    const uses = step.uses ? scalarText(step.uses) : "";
    if (!uses) return false;
    if (usesMatches(uses, SELF_ACTIONS)) self = true;
    else if (!usesMatches(uses, CHECKOUT_ACTIONS)) return false;
  }
  return self;
}

// Check one workflow. Returns { workflow, findings } where each finding is
// { workflow, job, line, status, detail, uses? }.
//   actions: accepted `uses:` targets
//   scanned: Set of workflow paths (relative to the repository root) included in this scan
export async function checkWorkflow({ name, content }, { actions = DEFAULT_ACTIONS, scanned = new Set([name]) } = {}) {
  const findings = [];
  const finding = (f) => findings.push({ workflow: name, ...f });

  if (isActionManifest(content)) {
    finding({ job: null, line: undefined, status: "not-a-workflow", detail: "action manifest, not a workflow; skipped" });
    return { workflow: name, findings };
  }

  const result = parseWorkflow({ name, content }, new NoOperationTraceWriter());
  const parseErrors = result.context.errors.getErrors();
  if (!result.value || parseErrors.length) {
    finding({
      job: null,
      line: parseErrors[0]?.range?.start?.line,
      status: "parse-error",
      detail: parseErrors.length ? parseErrors.map((e) => e.message).join(" | ") : "workflow could not be parsed",
    });
    return { workflow: name, findings };
  }

  const template = await convertWorkflowTemplate(result.context, result.value, undefined, {
    errorPolicy: ErrorPolicy.TryConversion,
  });
  if (template.errors?.length) {
    finding({
      job: null,
      line: undefined,
      status: "parse-error",
      detail: template.errors.map((e) => e.Message).join(" | "),
    });
    return { workflow: name, findings };
  }

  for (const job of template.jobs ?? []) {
    const id = scalarText(job.id);
    const jobLine = job.id?.range?.start?.line;

    if (job.type === "reusableWorkflowJob") {
      const ref = scalarText(job.ref);
      const local = normalizeLocalRef(ref);
      if (local !== null && scanned.has(local)) {
        finding({ job: id, line: jobLine, status: "ok", detail: `calls ${ref}, whose jobs are checked in this scan` });
      } else if (local !== null) {
        finding({
          job: id,
          line: jobLine,
          status: "reusable",
          detail: `calls ${ref}, which is not part of this scan; its jobs are not checked here`,
        });
      } else {
        finding({
          job: id,
          line: jobLine,
          status: "reusable",
          detail: `calls ${ref}; its jobs are checked in the repository that defines that workflow`,
        });
      }
      continue;
    }

    const steps = job.steps ?? [];
    const index = steps.findIndex((s) => s.uses && usesMatches(scalarText(s.uses), actions));
    const rawJob = mappingValue(mappingValue(result.value, "jobs"), id);
    if (index === -1 && isStatusOnlyJob(result.value, rawJob, steps)) {
      finding({ job: id, line: jobLine, status: "status-only", detail: "only an approved pinned status action, with explicit permissions: {} and no runtime overrides" });
      continue;
    }
    if (index === -1 && isCheckerJob(steps)) {
      finding({ job: id, line: jobLine, status: "checker", detail: "runs only checkout and ensure-secure-runner" });
      continue;
    }
    if (index === -1) {
      finding({
        job: id,
        line: jobLine,
        status: "missing",
        detail: steps.length
          ? `no step uses the secure-runner action; first step is ${describeStep(steps[0])}`
          : "job has no steps",
      });
      continue;
    }
    const step = steps[index];
    const uses = scalarText(step.uses);
    const stepLine = step.uses.range?.start?.line ?? jobLine;
    if (index > 0) {
      finding({
        job: id,
        line: stepLine,
        status: "not-first",
        detail: `secure-runner is step ${index + 1}; first step is ${describeStep(steps[0])}`,
        uses,
      });
    } else if (step.if && step.if.expression !== "success()") {
      finding({
        job: id,
        line: stepLine,
        status: "conditional",
        detail: `secure-runner step is conditional (if: ${step.if.expression}) so it may not run`,
        uses,
      });
    } else {
      finding({ job: id, line: jobLine, status: "ok", detail: uses, uses });
    }
  }
  return { workflow: name, findings };
}

// Check many workflows. files: [{ name, content }].
export async function checkWorkflows(files, options = {}) {
  const exemptions = parseExemptions(options.exemptions ?? "{}");
  const scanned = options.scanned ?? new Set(files.map((f) => f.name));
  const findings = [];
  for (const file of files) {
    const { findings: f } = await checkWorkflow(file, { ...options, scanned });
    findings.push(...f);
  }
  for (const [key, reason] of exemptions) {
    const target = findings.find((f) => f.job !== null && `${f.workflow}:${f.job}` === key);
    if (!target) throw new Error(`unused exemption ${JSON.stringify(key)}: no matching job in the scanned workflows`);
    if (target.status !== "missing") {
      throw new Error(`unused exemption ${JSON.stringify(key)}: job has status ${target.status}; remove the exemption or fix the job`);
    }
    target.status = "exempt";
    target.detail = reason;
  }
  const violations = findings.filter(isViolation);
  const jobs = findings.filter((f) => f.job !== null).length;
  const skipped = findings.filter((f) => f.status === "not-a-workflow").length;
  return { findings, violations, jobs, workflows: files.length - skipped, skipped, ok: violations.length === 0 };
}

export function formatLine(f) {
  const where = f.job === null ? f.workflow : `${f.workflow} › ${f.job}`;
  const label = { ok: "ok", reusable: "call", checker: "self", "status-only": "skip", exempt: "skip", "not-a-workflow": "skip" }[f.status] ?? "FAIL";
  const extra = f.status === "ok" ? f.detail : `${f.status}: ${f.detail}`;
  return `${label.padEnd(4)}  ${where}  (${extra})`;
}

// GitHub workflow-command annotation for a violation.
export function formatAnnotation(f) {
  const props = [`file=${f.workflow}`];
  if (f.line) props.push(`line=${f.line}`);
  props.push("title=ensure-secure-runner");
  const subject = f.job === null ? `Workflow ${f.workflow}` : `Job '${f.job}'`;
  const message = `${subject}: ${f.status}: ${f.detail}`;
  return `::error ${props.join(",")}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

function cell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// Markdown for $GITHUB_STEP_SUMMARY.
export function formatSummary(report, { actions = DEFAULT_ACTIONS } = {}) {
  const out = ["## Secure runner check", ""];
  out.push(
    report.ok
      ? `✅ No secure-runner policy violations across ${report.jobs} job(s) in ${report.workflows} workflow(s). Accepted actions: \`${actions.join("`, `")}\`.`
      : `❌ ${report.violations.length} violation(s) across ${report.workflows} workflow(s); ${report.jobs} job(s) checked.`,
  );
  out.push("");
  const exemptions = report.findings.filter((f) => f.status === "status-only" || f.status === "exempt");
  if (exemptions.length) {
    out.push("### Exempt jobs", "", "| Workflow | Job | Status | Reason |", "|---|---|---|---|");
    for (const f of exemptions) out.push(`| \`${cell(f.workflow)}\` | \`${cell(f.job)}\` | ${f.status} | ${cell(f.detail)} |`);
    out.push("");
  }
  if (report.violations.length) {
    out.push("| Workflow | Job | Line | Problem | Detail |", "|---|---|---|---|---|");
    for (const f of report.violations) {
      out.push(`| \`${cell(f.workflow)}\` | ${f.job === null ? "" : `\`${cell(f.job)}\``} | ${f.line ?? ""} | ${f.status} | ${cell(f.detail)} |`);
    }
    out.push("");
  }
  const reusable = report.findings.filter((f) => f.status === "reusable");
  if (reusable.length) {
    out.push(
      "### Reusable workflow calls not checked here",
      "",
      "These jobs run another workflow's jobs, which this scan cannot inspect. Run this check in the repository that defines the called workflow.",
      "",
      "| Workflow | Job | Calls |",
      "|---|---|---|",
    );
    for (const f of reusable) out.push(`| \`${cell(f.workflow)}\` | \`${cell(f.job)}\` | \`${cell(f.detail.replace(/^calls /, "").replace(/[;,].*$/, ""))}\` |`);
    out.push("");
  }
  return out.join("\n");
}
