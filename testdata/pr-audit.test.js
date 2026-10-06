const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/pr-audit.yml"), "utf8",
);
const gate = workflow.split("\n  require-completed-audit:\n")[1]
  .split("  pass-merge-group-audit:\n")[0];
const condition = gate.match(/    if: >-\n([\s\S]*?)    concurrency:/)[1];
const shouldRun = new Function("github", "inputs", "startsWith",
  `return ${condition.replaceAll("inputs.require-completed-audit", "inputs.enabled")}`,
);
const script = gate.split("          script: |\n")[1]
  .split("\n").map(line => line.replace(/^ {12}/, "")).join("\n");
const reportStatus = new (Object.getPrototypeOf(async function () {}).constructor)(
  "github", "context", script,
);
const heading = ":eye: **Cyclops Review** — No actionable findings.";
const marked = "<!-- cyclops:review run=pr-7910 head=dbc79341469a3a198d224d6998b4059e4db38547 -->\n" + heading;

function reviewEvent(body, userId = 258930814) {
  return {
    event_name: "pull_request_review",
    repository: "tempoxyz/tempo",
    event: {
      review: { body, user: { id: userId } },
      pull_request: {
        head: { repo: { full_name: "tempoxyz/tempo" } },
        user: { login: "author" },
      },
    },
  };
}

for (const body of [heading, marked]) {
  test(`runs the gate for ${body === heading ? "legacy" : "marked"} Cyclops reviews`, () => {
    assert.equal(shouldRun(reviewEvent(body), { enabled: true },
      (value, prefix) => value.startsWith(prefix)), true);
    assert.equal(shouldRun(reviewEvent(body, 123), { enabled: true },
      (value, prefix) => value.startsWith(prefix)), false);
    assert.equal(shouldRun(reviewEvent(body), { enabled: false },
      (value, prefix) => value.startsWith(prefix)), false);
  });
}

async function statusFor(body, userId = 258930814) {
  const statuses = [];
  const pull = {
    number: 7910,
    head: { sha: "current-head", repo: { full_name: "tempoxyz/tempo" } },
    user: { login: "author" },
    html_url: "https://github.com/tempoxyz/tempo/pull/7910",
  };
  await reportStatus({
    rest: {
      pulls: { get: async () => ({ data: pull }), listReviews: () => {} },
      repos: { createCommitStatus: async status => statuses.push(status) },
    },
    paginate: async () => [{
      body, user: { id: userId }, html_url: `${pull.html_url}#review`,
    }],
  }, {
    repo: { owner: "tempoxyz", repo: "tempo" },
    payload: { pull_request: { number: 7910 } },
  });
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].context, "Cyclops audit run");
  assert.equal(statuses[0].sha, "current-head");
  return statuses[0];
}

for (const [name, body] of [
  ["legacy", heading], ["marked", marked], ["CRLF marked", marked.replace("\n", "\r\n")],
  ["marked with a blank line", marked.replace("\n", "\n\n")],
  ["CRLF marked with a blank line", marked.replace("\n", "\r\n\r\n")],
]) {
  test(`publishes success for a ${name} review`, async () => {
    const status = await statusFor(body);
    assert.equal(status.state, "success");
    assert.equal(status.target_url, "https://github.com/tempoxyz/tempo/pull/7910#review");
  });
}

test("does not accept another author's review", async () => {
  assert.equal((await statusFor(marked, 123)).state, "pending");
  assert.equal((await statusFor(marked.replace("\n", "\n\n"), 123)).state, "pending");
});

for (const body of [undefined, "Unrelated review", marked.split("\n")[0],
  "<!-- unrelated -->\n" + heading, "Quoted review:\n" + heading]) {
  test(`keeps unrecognized review pending: ${body}`, async () => {
    assert.equal((await statusFor(body)).state, "pending");
  });
}

function stepScript(name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const script = [];
  for (const line of lines.slice(run + 1)) {
    if (line && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

// `pulls` lists what successive `gh api` PR reads return; `sleep` is stubbed out.
function resolveTarget(overrides, pulls = [], step = "Resolve target") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-resolve-"));
  const output = path.join(tmp, "output");
  fs.writeFileSync(output, "");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tmp, "pulls"), pulls.map(value => `${value}\n`).join(""));
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
echo "$*" >> "${tmp}/gh-calls"
value=$(head -n 1 "${tmp}/pulls")
tail -n +2 "${tmp}/pulls" > "${tmp}/rest" && mv "${tmp}/rest" "${tmp}/pulls"
echo "\${value:-0123456789abcdef null}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/usr/bin/env bash\n", { mode: 0o755 });
  try {
    const result = spawnSync("bash", ["-c", stepScript(step)], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        AUDIT_ENV: "prod",
        AUDIT_ON_PUSH: "false",
        EVENT_NAME: "pull_request",
        EVENT_ACTION: "labeled",
        LABEL_NAME: "cyclops",
        REQUIRED_LABEL: "cyclops",
        REQUIRED_LABELS: "",
        PR_DRAFT: "false",
        PR_HEAD_REPO: "tempoxyz/example",
        PR_HEAD_SHA: "0123456789abcdef",
        PR_NUMBER: "123",
        REPO: "tempoxyz/example",
        ...overrides,
      },
    });
    const outputs = Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n")
      .filter(Boolean).map(line => [line.split("=")[0], line.slice(line.indexOf("=") + 1)]));
    const ghCalls = fs.existsSync(path.join(tmp, "gh-calls"))
      ? fs.readFileSync(path.join(tmp, "gh-calls"), "utf8").trim().split("\n") : [];
    return { status: result.status, log: result.stdout + result.stderr, outputs, ghCalls };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

for (const [env, channel] of [["staging", "staging"], ["AB", "ab"], ["prod", ""], ["Production", ""]]) {
  test(`env=${env} resolves runner_channel "${channel}"`, () => {
    const { status, outputs } = resolveTarget({ AUDIT_ENV: env });
    assert.equal(status, 0);
    assert.equal(outputs.runner_channel, channel);
    assert.equal(outputs.publish, "true");
  });
}

for (const env of ["dev", ""]) {
  test(`invalid env input "${env}" fails`, () => {
    const { status, log, outputs } = resolveTarget({ AUDIT_ENV: env });
    assert.notEqual(status, 0);
    assert.match(log, /Invalid env input/);
    assert.equal(outputs.publish, undefined);
  });
}

for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
  test(`audit-on-push publishes on ${action}`, () => {
    const { status, outputs } = resolveTarget({ AUDIT_ON_PUSH: "true", EVENT_ACTION: action });
    assert.equal(status, 0);
    assert.deepEqual(outputs, {
      runner_channel: "", pr_number: "123", sha: "0123456789abcdef", publish: "true",
    });
    assert.equal(resolveTarget({ EVENT_ACTION: action }).outputs.publish, "false");
  });
}

for (const [name, overrides] of [
  ["draft PRs", { PR_DRAFT: "true" }],
  ["fork PRs", { PR_HEAD_REPO: "external/example" }],
  ["PRs without a head repo", { PR_HEAD_REPO: "" }],
  ["other actions", { EVENT_ACTION: "edited" }],
]) {
  test(`audit-on-push skips ${name}`, () => {
    const { status, outputs } = resolveTarget({
      AUDIT_ON_PUSH: "true", EVENT_ACTION: "synchronize", ...overrides,
    });
    assert.equal(status, 0);
    assert.equal(outputs.publish, "false");
  });
}

test("labels still gate labeled events with audit-on-push", () => {
  assert.equal(resolveTarget({ AUDIT_ON_PUSH: "true", LABEL_NAME: "other" }).outputs.publish, "false");
  assert.equal(resolveTarget({ AUDIT_ON_PUSH: "true", PR_DRAFT: "true" }).outputs.publish, "true");
});

const probe = (pulls, overrides = {}) => resolveTarget(overrides, pulls, "Check for a conflicting push");
const head = "0123456789abcdef";

test("flags a push to a conflicting PR once mergeability resolves", () => {
  const { status, outputs, ghCalls } = probe([`${head} null`, `${head} false`]);
  assert.equal(status, 0);
  assert.deepEqual(outputs, { conflicting: "true" });
  assert.equal(ghCalls.length, 2);
  assert.match(ghCalls[0], /^api repos\/tempoxyz\/example\/pulls\/123 --jq /);
});

for (const [name, pulls] of [
  ["mergeable PRs", [`${head} true`]],
  ["a conflict on a newer head", ["fedcba9876543210 false"]],
  ["unresolved mergeability", []],
]) {
  test(`does not flag ${name}`, () => {
    assert.deepEqual(probe(pulls).outputs, { conflicting: "false" });
  });
}

test("stops polling after a minute", () => {
  assert.equal(probe([]).ghCalls.length, 12);
});

for (const [name, overrides] of [
  ["draft PRs", { PR_DRAFT: "true" }],
  ["fork PRs", { PR_HEAD_REPO: "external/example" }],
]) {
  test(`does not probe ${name}`, () => {
    const { outputs, ghCalls } = probe([`${head} false`], overrides);
    assert.deepEqual(outputs, { conflicting: "false" });
    assert.deepEqual(ghCalls, []);
  });
}

test("publishes a pull_request_target push the probe flagged", () => {
  const { status, outputs, ghCalls } = resolveTarget({ EVENT_NAME: "pull_request_target", EVENT_ACTION: "synchronize" });
  assert.equal(status, 0);
  assert.deepEqual(outputs, { runner_channel: "", pr_number: "123", sha: head, publish: "true" });
  assert.deepEqual(ghCalls, []);
});
