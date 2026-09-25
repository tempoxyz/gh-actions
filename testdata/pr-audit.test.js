const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
]) {
  test(`publishes success for a ${name} review`, async () => {
    const status = await statusFor(body);
    assert.equal(status.state, "success");
    assert.equal(status.target_url, "https://github.com/tempoxyz/tempo/pull/7910#review");
  });
}

test("does not accept another author's review", async () => {
  assert.equal((await statusFor(marked, 123)).state, "pending");
});

for (const body of [undefined, "Unrelated review", marked.split("\n")[0],
  "<!-- unrelated -->\n" + heading, "Quoted review:\n" + heading]) {
  test(`keeps unrecognized review pending: ${body}`, async () => {
    assert.equal((await statusFor(body)).state, "pending");
  });
}
