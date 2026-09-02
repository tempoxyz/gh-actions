#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const API = "https://api.github.com";
const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 };
const WORKFLOW_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const ACTION_RE = /(^|\/)(action\.ya?ml|\.github\/actions\/.*\/action\.ya?ml)$/i;

export const CHECKS = {
  default_branch_review: {
    severity: "high",
    component: "vcs",
    techniques: ["T-V002", "T-V010", "T-V011"],
    title: "Default branch does not require pull-request review",
    remediation: "Require pull requests, at least one approving review, dismissal of stale approvals, and protected tag/reference rules.",
  },
  actions_default_write: {
    severity: "high",
    component: "cicd",
    techniques: ["T-C002", "T-C008"],
    title: "GitHub Actions defaults to write permissions",
    remediation: "Set the default workflow token permission to read and grant narrow write permissions per job.",
  },
  actions_can_approve: {
    severity: "high",
    component: "cicd",
    techniques: ["T-C008", "T-C012"],
    title: "GitHub Actions can approve pull requests",
    remediation: "Disable workflow-created pull-request approvals unless a reviewed automation flow requires it.",
  },
  mutable_action_ref: {
    severity: "high",
    component: "cicd",
    techniques: ["T-C002", "T-C009"],
    title: "Third-party or reusable action uses a mutable reference",
    remediation: "Pin every external action and reusable workflow to a full commit SHA and use a dependency updater for reviewed repins.",
  },
  privileged_pr_trigger: {
    severity: "medium",
    component: "cicd",
    techniques: ["T-C003", "T-C005"],
    title: "Workflow uses a privileged pull_request_target trigger",
    remediation: "Review the trust boundary; never check out or execute pull-request-controlled content, and grant only the permissions the metadata operation needs.",
  },
  pwn_request: {
    severity: "high",
    component: "cicd",
    techniques: ["T-C003", "T-C005"],
    title: "Privileged pull-request workflow checks out a PR-controlled revision",
    remediation: "Confirm no PR-controlled code executes and no privileged credential reaches tools that process the checkout; otherwise split privileged metadata work from untrusted-code testing.",
  },
  script_injection: {
    severity: "critical",
    component: "cicd",
    techniques: ["T-C004", "T-C005"],
    title: "Run script interpolates pull-request-controlled data",
    remediation: "Pass event data through a quoted environment variable and treat it as untrusted input.",
  },
  self_hosted_runner: {
    severity: "high",
    component: "cicd",
    techniques: ["T-C013", "T-C016", "T-C017", "T-P003"],
    title: "Workflow uses a self-hosted runner",
    remediation: "Use ephemeral isolated runners, block untrusted triggers, minimize network reachability, and destroy the runner after one job.",
  },
  broad_write_permissions: {
    severity: "medium",
    component: "cicd",
    techniques: ["T-C005", "T-C008", "T-C012"],
    title: "Workflow requests write permissions",
    remediation: "Set permissions to an empty object at workflow level and grant only required scopes on the specific job.",
  },
  secret_enumeration: {
    severity: "critical",
    component: "cicd",
    techniques: ["T-C015"],
    title: "Workflow serializes the complete secrets context",
    remediation: "Remove toJson(secrets) and expose only individually required secrets to the narrowest step.",
  },
  publish_without_provenance: {
    severity: "medium",
    component: "registry",
    techniques: ["T-R004", "T-R005", "T-P004"],
    title: "Publishing workflow has no observable provenance or signing step",
    remediation: "Generate build provenance/attestations and sign published packages or images with an identity-bound signer.",
  },
  deploy_without_environment: {
    severity: "high",
    component: "production",
    techniques: ["T-P001", "T-P002", "T-P005"],
    title: "Deployment workflow has no GitHub Environment gate",
    remediation: "Use a protected GitHub Environment with required reviewers, scoped secrets, and deployment-branch restrictions.",
  },
  unlocked_dependencies: {
    severity: "low",
    component: "endpoint",
    techniques: ["T-E001", "T-R010", "T-R011", "T-R012"],
    title: "Dependency manifest has no recognized lockfile in its directory ancestry",
    remediation: "For applications and CI tooling, commit the ecosystem lockfile and use frozen/locked installation; confirm intentional omissions for published libraries.",
  },
  dependency_updates_missing: {
    severity: "low",
    component: "registry",
    techniques: ["T-R010", "T-R011", "T-R012"],
    title: "No automated dependency-update configuration is present",
    remediation: "Enable Dependabot or Renovate with reviewed, grouped, and rate-limited updates.",
  },
  secret_scanning_disabled: {
    severity: "high",
    component: "vcs",
    techniques: ["T-V003", "T-C006"],
    title: "Secret scanning is disabled",
    remediation: "Enable secret scanning and push protection for supported repositories.",
  },
  push_protection_disabled: {
    severity: "high",
    component: "vcs",
    techniques: ["T-V003", "T-C006"],
    title: "Secret-scanning push protection is disabled",
    remediation: "Enable push protection and tightly control bypasses.",
  },
};

class GitHubClient {
  constructor(token, api = API) {
    this.token = token;
    this.api = api;
  }

  async request(endpoint, { allow = [], raw = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${this.api}${endpoint}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "tempoxyz-sitf-org-audit",
        },
      });
      if (allow.includes(response.status)) return { status: response.status, data: null };
      if (response.ok) return { status: response.status, data: raw ? await response.text() : await response.json() };
      if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) {
        const delay = Math.min(Number(response.headers.get("retry-after") || 1), 5) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const body = await response.text();
      throw new Error(`${response.status} ${endpoint}: ${body.slice(0, 240)}`);
    }
    throw new Error(`request retry exhausted: ${endpoint}`);
  }

  async paginate(endpoint) {
    const results = [];
    for (let page = 1; ; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const { data } = await this.request(`${endpoint}${separator}per_page=100&page=${page}`);
      results.push(...data);
      if (data.length < 100) return results;
    }
  }

  async publicFile(repo, branch, filePath) {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${encodedPath}`, {
        headers: { "User-Agent": "tempoxyz-sitf-org-audit" },
      });
      if (response.ok) return response.text();
      if (attempt === 0 && [429, 502, 503, 504].includes(response.status)) continue;
      throw new Error(`${response.status} raw ${repo}/${branch}/${filePath}`);
    }
    throw new Error(`raw file retry exhausted: ${repo}/${branch}/${filePath}`);
  }
}

function bool(value, fallback = true) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

export function parseTargets(value) {
  return [...new Set(String(value || "").split(/[\n,]+/).map((v) => v.trim()).filter(Boolean))];
}

function finding(repo, checkId, evidence, extra = {}) {
  return { repo: repo.full_name, check_id: checkId, ...CHECKS[checkId], evidence, ...extra };
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function matchesWithLines(text, regex) {
  const matches = [];
  for (const match of text.matchAll(regex)) matches.push({ value: match[0].trim(), line: lineNumber(text, match.index) });
  return matches;
}

function isImmutableUse(value) {
  if (value.startsWith("./") || value.startsWith("docker://") && /@sha256:[a-f0-9]{64}$/i.test(value)) return true;
  const at = value.lastIndexOf("@");
  return at > 0 && /^[a-f0-9]{40}$/i.test(value.slice(at + 1));
}

function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    let value = match[2];
    let end = index;
    if (/^[|>][-+]?\s*(?:#.*)?$/.test(value)) {
      value = "";
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const nextIndent = (lines[cursor].match(/^\s*/) || [""])[0].length;
        if (lines[cursor].trim() && nextIndent <= indent) break;
        value += `${lines[cursor]}\n`;
        end = cursor;
      }
    }
    blocks.push({ start: index + 1, end: end + 1, value });
  }
  return blocks;
}

export function analyzeWorkflow(repo, file, text) {
  const findings = [];
  const add = (check, matches) => {
    if (!matches.length) return;
    const evidence = matches.slice(0, 12).map((m) => `${file.path}:${m.line} (${m.value.replace(/\s+/g, " ").slice(0, 140)})`);
    findings.push(finding(repo, check, evidence, { path: file.path }));
  };

  const uses = matchesWithLines(text, /^\s*-?\s*uses:\s*["']?([^\s#"']+)["']?/gim)
    .map((match) => ({ ...match, action: match.value.replace(/^.*?uses:\s*["']?/, "").replace(/["']$/, "") }));
  add("mutable_action_ref", uses.filter((match) => !isImmutableUse(match.action)));

  add("privileged_pr_trigger", matchesWithLines(text, /^\s*pull_request_target\s*:/gim));
  const privileged = /^\s*pull_request_target\s*:/im.test(text);
  const untrustedCheckout = /uses:\s*["']?actions\/checkout@/i.test(text) && /github\.event\.pull_request\.head\.(sha|ref|repo)/i.test(text);
  const untrustedCommand = /\bgh\s+pr\s+checkout\b|refs\/pull\/\$\{\{/i.test(text);
  if (privileged && (untrustedCheckout || untrustedCommand)) add("pwn_request", [{ value: "pull_request_target combined with pull-request-controlled checkout", line: 1 }]);
  add("self_hosted_runner", matchesWithLines(text, /^\s*runs-on\s*:.*self-hosted.*$/gim));
  add("broad_write_permissions", matchesWithLines(text, /^\s*(permissions\s*:\s*write-all|(contents|actions|checks|deployments|packages|pull-requests|security-events|statuses)\s*:\s*write)\s*(?:#.*)?$/gim));
  add("secret_enumeration", matchesWithLines(text, /\$\{\{\s*toJson\(secrets\)\s*\}\}/gim));

  const unsafeExpression = /\$\{\{\s*github\.event\.(pull_request\.(title|body|head\.ref|head\.label)|issue\.title|issue\.body|comment\.body|review\.body|review_comment\.body|pages\.[^}\s]+)\s*\}\}/gim;
  const injections = [];
  for (const block of runBlocks(text)) {
    for (const match of block.value.matchAll(unsafeExpression)) injections.push({ value: match[0], line: block.start + lineNumber(block.value, match.index) - 1 });
  }
  add("script_injection", injections);

  const publishes = /\b(npm\s+publish|cargo\s+publish|docker\s+(push|buildx\s+build[^\n]*--push)|gh\s+release\s+create|twine\s+upload|maturin\s+publish)\b|docker\/build-push-action@/i.test(text);
  const provenance = /\b(cosign|attest(?:ation)?|provenance|slsa|sigstore)\b|actions\/attest-/i.test(text);
  if (publishes && !provenance) add("publish_without_provenance", [{ value: "publish command/action without signing or attestation marker", line: 1 }]);

  const deploys = /\b(kubectl\s+(apply|set|rollout)|helm\s+(install|upgrade)|terraform\s+apply|gcloud\s+(run|app)\s+deploy|aws\s+[^\n]*(deploy|update-service))\b/i.test(text);
  if (deploys && !/^\s*environment\s*:/im.test(text)) add("deploy_without_environment", [{ value: "deployment command without an environment key", line: 1 }]);
  return findings;
}

export function analyzeTree(repo, tree) {
  const paths = new Set(tree.map((entry) => entry.path));
  const findings = [];
  const manifests = {
    "package.json": ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"],
    "Cargo.toml": ["Cargo.lock"],
    "go.mod": ["go.sum"],
    "Gemfile": ["Gemfile.lock"],
    "Pipfile": ["Pipfile.lock"],
    "pyproject.toml": ["uv.lock", "poetry.lock", "pdm.lock"],
    "composer.json": ["composer.lock"],
  };
  const unlocked = [];
  for (const [manifest, locks] of Object.entries(manifests)) {
    for (const manifestPath of paths) {
      if (!(manifestPath === manifest || manifestPath.endsWith(`/${manifest}`))) continue;
      const directory = path.posix.dirname(manifestPath);
      let ancestor = directory;
      let hasLock = false;
      while (!hasLock) {
        hasLock = locks.some((lock) => paths.has(ancestor === "." ? lock : `${ancestor}/${lock}`));
        if (ancestor === ".") break;
        ancestor = path.posix.dirname(ancestor);
      }
      if (!hasLock) unlocked.push(manifestPath);
    }
  }
  if (unlocked.length) findings.push(finding(repo, "unlocked_dependencies", unlocked.slice(0, 12)));
  const updater = [...paths].some((entry) => entry === ".github/dependabot.yml" || /(^|\/)renovate\.json5?$/.test(entry) || entry.endsWith("/.renovaterc"));
  if (Object.keys(manifests).some((manifest) => [...paths].some((entry) => entry === manifest || entry.endsWith(`/${manifest}`))) && !updater) {
    findings.push(finding(repo, "dependency_updates_missing", ["No .github/dependabot.yml or Renovate configuration on the default branch"]));
  }
  return findings;
}

function activePullRequestRule(rules) {
  return Array.isArray(rules) && rules.some((rule) => rule.type === "pull_request");
}

async function setting(client, endpoint, limitations, repoName) {
  try {
    return await client.request(endpoint, { allow: [404] });
  } catch (error) {
    limitations.push(`${repoName}: ${error.message}`);
    return { status: 0, data: null };
  }
}

async function scanRepository(client, repo) {
  const result = { repo: repo.full_name, status: "searched", workflows: 0, findings: [], limitations: [] };
  if (!repo.default_branch || repo.size === 0) {
    result.status = "skipped";
    result.reason = "empty repository";
    return result;
  }
  try {
    const branch = encodeURIComponent(repo.default_branch);
    const [protection, rules, workflowPermissions] = await Promise.all([
      setting(client, `/repos/${repo.full_name}/branches/${branch}/protection`, result.limitations, repo.full_name),
      setting(client, `/repos/${repo.full_name}/rules/branches/${branch}`, result.limitations, repo.full_name),
      setting(client, `/repos/${repo.full_name}/actions/permissions/workflow`, result.limitations, repo.full_name),
    ]);

    const review = protection.data?.required_pull_request_reviews || activePullRequestRule(rules.data);
    const protectionKnown = protection.status === 404 || protection.data !== null;
    const rulesKnown = rules.status === 404 || rules.data !== null;
    if (protectionKnown && rulesKnown && !review) {
      result.findings.push(finding(repo, "default_branch_review", [`${repo.default_branch}: no required pull-request review rule observed`]));
    }
    if (workflowPermissions.data?.default_workflow_permissions === "write") {
      result.findings.push(finding(repo, "actions_default_write", ["default_workflow_permissions=write"]));
    }
    if (workflowPermissions.data?.can_approve_pull_request_reviews === true) {
      result.findings.push(finding(repo, "actions_can_approve", ["can_approve_pull_request_reviews=true"]));
    }

    const security = repo.security_and_analysis || {};
    if (security.secret_scanning?.status === "disabled") result.findings.push(finding(repo, "secret_scanning_disabled", ["security_and_analysis.secret_scanning.status=disabled"]));
    if (security.secret_scanning_push_protection?.status === "disabled") result.findings.push(finding(repo, "push_protection_disabled", ["security_and_analysis.secret_scanning_push_protection.status=disabled"]));

    let treeResponse = await client.request(`/repos/${repo.full_name}/git/trees/${branch}?recursive=1`, { allow: [404] });
    if (treeResponse.status === 404) {
      const branchData = (await client.request(`/repos/${repo.full_name}/branches/${branch}`)).data;
      const commitData = (await client.request(`/repos/${repo.full_name}/git/commits/${branchData.commit.sha}`)).data;
      if (commitData.tree.sha === "4b825dc642cb6eb9a060e54bf8d69288fbee4904") {
        result.status = "skipped";
        result.reason = "empty default branch";
        return result;
      }
      treeResponse = await client.request(`/repos/${repo.full_name}/git/trees/${commitData.tree.sha}?recursive=1`);
    }
    const tree = treeResponse.data.tree || [];
    if (treeResponse.data.truncated) result.limitations.push(`${repo.full_name}: recursive tree response was truncated`);
    result.findings.push(...analyzeTree(repo, tree));
    const files = tree.filter((entry) => entry.type === "blob" && (WORKFLOW_RE.test(entry.path) || ACTION_RE.test(entry.path)));
    result.workflows = files.filter((entry) => WORKFLOW_RE.test(entry.path)).length;
    const contents = await mapLimit(files, 8, async (file) => {
      if (!repo.private) return { file, text: await client.publicFile(repo.full_name, repo.default_branch, file.path) };
      const { data } = await client.request(`/repos/${repo.full_name}/git/blobs/${file.sha}`);
      return { file, text: data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content };
    });
    for (const { file, text } of contents) result.findings.push(...analyzeWorkflow(repo, file, text));
  } catch (error) {
    result.status = "failed";
    result.reason = error.message;
  }
  return result;
}

export async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function resolveRepositories(client, targets, options, limitations) {
  const repositories = new Map();
  for (const target of targets) {
    try {
      const values = target.includes("/")
        ? [(await client.request(`/repos/${target}`)).data]
        : await client.paginate(`/orgs/${target}/repos?type=all`);
      for (const repo of values) {
        if (!options.includeArchived && repo.archived || !options.includeForks && repo.fork) continue;
        repositories.set(repo.full_name, repo);
      }
    } catch (error) {
      limitations.push(`${target}: ${error.message}`);
    }
  }
  return [...repositories.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export function summarize(findings) {
  const severities = { critical: 0, high: 0, medium: 0, low: 0 };
  const checks = {};
  const components = {};
  for (const item of findings) {
    severities[item.severity] += 1;
    checks[item.check_id] ||= { ...CHECKS[item.check_id], count: 0, repositories: new Set() };
    checks[item.check_id].count += 1;
    checks[item.check_id].repositories.add(item.repo);
    components[item.component] = (components[item.component] || 0) + 1;
  }
  return {
    severities,
    components,
    checks: Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, { ...value, repositories: [...value.repositories].sort() }])),
  };
}

export function markdown(report) {
  const searched = report.repositories.filter((repo) => repo.status === "searched").length;
  const skipped = report.repositories.filter((repo) => repo.status === "skipped").length;
  const failed = report.repositories.filter((repo) => repo.status === "failed").length;
  const lines = [
    "# SITF GitHub SDLC assessment",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "This read-only assessment maps observable GitHub settings and default-branch files to the [Wiz SDLC Infrastructure Threat Framework (SITF)](https://github.com/wiz-sec-public/SITF). A finding is an attack-enabling condition to review, not proof of exploitation. Endpoint, identity-provider, registry, runner-host, and production controls that GitHub cannot expose are outside this scan.",
    "",
    "## Executive summary",
    "",
    `- Targets: ${report.targets.map((target) => `\`${target}\``).join(", ")}`,
    `- Repositories: ${report.repositories.length} enumerated; ${searched} searched; ${skipped} skipped; ${failed} failed`,
    `- Default-branch workflow files: ${report.repositories.reduce((sum, repo) => sum + repo.workflows, 0)}`,
    `- Findings: ${report.findings.length} total — ${report.summary.severities.critical} critical, ${report.summary.severities.high} high, ${report.summary.severities.medium} medium, ${report.summary.severities.low} low`,
    "",
    "## Findings by control gap",
    "",
    "| Severity | Control gap | SITF techniques | Repositories | Findings |",
    "|---|---|---|---:|---:|",
  ];
  const checks = Object.entries(report.summary.checks).sort((a, b) => SEVERITY_ORDER[b[1].severity] - SEVERITY_ORDER[a[1].severity] || b[1].count - a[1].count);
  for (const [, check] of checks) {
    lines.push(`| ${check.severity} | ${check.title} | ${check.techniques.join(", ")} | ${check.repositories.length} | ${check.count} |`);
  }
  lines.push("", "## Recommended order of operations", "");
  for (const [id, check] of checks) {
    lines.push(`1. **${check.title}** (${check.severity}; ${check.repositories.length} repositories): ${CHECKS[id].remediation}`);
  }
  lines.push("", "## Repository coverage", "", "| Repository | Status | Workflows | Findings | Notes |", "|---|---|---:|---:|---|");
  for (const repo of report.repositories) {
    const notes = repo.reason || (repo.limitations.length ? `${repo.limitations.length} setting(s) unavailable` : "");
    lines.push(`| [${repo.repo}](https://github.com/${repo.repo}) | ${repo.status} | ${repo.workflows} | ${repo.findings.length} | ${String(notes).replaceAll("|", "\\|")} |`);
  }
  lines.push("", "## Detailed findings", "");
  for (const item of report.findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.repo.localeCompare(b.repo))) {
    lines.push(`### ${item.severity.toUpperCase()}: ${item.title}`, "", `- Repository: [${item.repo}](https://github.com/${item.repo})`, `- SITF: ${item.techniques.join(", ")}`, `- Evidence: ${item.evidence.join("; ")}`, `- Remediation: ${item.remediation}`, "");
  }
  const limitations = [...report.limitations, ...report.repositories.flatMap((repo) => repo.limitations)];
  lines.push("## Limitations", "");
  if (!limitations.length) lines.push("- No API or repository-scan failures were observed.");
  else for (const value of limitations) lines.push(`- ${value}`);
  lines.push("", "## Method", "", "The scanner exhaustively enumerates repositories visible to its token for organization targets, then inspects each current default branch. It reads active branch rules/protection, repository Actions token defaults, repository security-analysis metadata, dependency manifests/lockfiles, and workflow/action YAML. It includes archived repositories and forks unless configured otherwise. It does not inspect other branches, tags, history, issues, pull requests, runtime logs, cloud accounts, identity-provider settings, package-registry ACLs, or runner hosts.", "");
  return lines.join("\n");
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  return fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function run(options = {}) {
  const targets = options.targets || parseTargets(process.env.SITF_TARGETS);
  const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!targets.length) throw new Error("SITF_TARGETS must contain at least one organization or owner/repository");
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  const outputDirectory = path.resolve(options.outputDirectory || process.env.SITF_OUTPUT_DIRECTORY || "sitf-audit");
  const client = options.client || new GitHubClient(token, options.api);
  const limitations = [];
  const repositories = await resolveRepositories(client, targets, {
    includeArchived: options.includeArchived ?? bool(process.env.SITF_INCLUDE_ARCHIVED, true),
    includeForks: options.includeForks ?? bool(process.env.SITF_INCLUDE_FORKS, true),
  }, limitations);
  const scanned = await mapLimit(repositories, options.concurrency || 8, (repo) => scanRepository(client, repo));
  const findings = scanned.flatMap((repo) => repo.findings);
  const report = { schema_version: 1, generated_at: new Date().toISOString(), targets, repositories: scanned, findings, limitations, summary: summarize(findings) };
  await fs.mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "sitf-audit.json");
  const markdownPath = path.join(outputDirectory, "sitf-audit.md");
  await Promise.all([fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`), fs.writeFile(markdownPath, markdown(report))]);
  await Promise.all([output("markdown", markdownPath), output("json", jsonPath), output("findings", findings.length), output("failed-repositories", scanned.filter((repo) => repo.status === "failed").length)]);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown(report));
  const threshold = String(options.failOn || process.env.SITF_FAIL_ON || "none").toLowerCase();
  if (threshold !== "none" && !SEVERITY_ORDER[threshold]) throw new Error(`Invalid SITF_FAIL_ON value: ${threshold}`);
  if (threshold !== "none" && findings.some((item) => SEVERITY_ORDER[item.severity] >= SEVERITY_ORDER[threshold])) process.exitCode = 2;
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) run().then((report) => {
  const failed = report.repositories.filter((repo) => repo.status === "failed").length;
  console.log(`SITF audit: ${report.repositories.length} repositories, ${report.findings.length} findings, ${failed} failures`);
}).catch((error) => {
  console.error(`SITF audit failed: ${error.message}`);
  process.exitCode = 1;
});
