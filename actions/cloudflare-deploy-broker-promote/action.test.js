const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const fakeHttps = path.join(
  __dirname,
  "../../testdata/cloudflare-deploy-broker/fake-https.cjs",
);
const operationId = "44444444-4444-4444-8444-444444444444";
const stableVersionId = "00000000-0000-4000-8000-000000000000";
const candidateVersionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "77777777-7777-4777-8777-777777777777";

const validInputs = {
  "INPUT_DEPLOYMENT-ID": "example-worker",
  "INPUT_OPERATION-ID": operationId,
  INPUT_ACTION: "promote",
  INPUT_HOST: "",
  GITHUB_RUN_ID: "1",
  GITHUB_SHA: "c".repeat(40),
};

function run(env, responses = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "broker-promote-"));
  const capture = path.join(directory, "requests.jsonl");
  const outputs = path.join(directory, "outputs");
  writeFileSync(capture, "");
  writeFileSync(outputs, "");
  const result = spawnSync(
    process.execPath,
    ["--require", fakeHttps, path.join(__dirname, "main.cjs")],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/oidc?x=1",
        GITHUB_OUTPUT: outputs,
        FAKE_HTTPS_CAPTURE: capture,
        FAKE_HTTPS_RESPONSES: JSON.stringify(responses),
        ...env,
      },
    },
  );
  return {
    ...result,
    requests: readFileSync(capture, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    outputs: Object.fromEntries(
      readFileSync(outputs, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    ),
  };
}

function brokerResult(action, changes = {}) {
  const promote = action === "promote";
  return {
    operationId,
    action,
    state: promote ? "promoted" : "rolled_back",
    policyDigest: "a".repeat(64),
    workerName: "example-worker",
    workerTag: "b".repeat(32),
    versionId: promote ? candidateVersionId : stableVersionId,
    deploymentId,
    stableVersionId,
    candidateVersionId,
    changed: true,
    verificationUrl: "https://example-worker.tempoxyz.net",
    ...changes,
  };
}

test("runs on the runner's Node.js with the deploy action's broker client", () => {
  const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
  assert.match(action, /\nruns:\n  using: node24\n  main: main\.cjs\n$/);
  assert.ok(action.includes('default: "cf.tempoxyz.net"'));
});

test("names the invalid input before any request", () => {
  for (const [name, value] of [
    ["INPUT_DEPLOYMENT-ID", "Not Valid"],
    ["INPUT_OPERATION-ID", "not-a-uuid"],
    ["INPUT_ACTION", "deploy"],
  ]) {
    const result = run({ ...validInputs, [name]: value });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`${name.slice(6).toLowerCase()} is missing or invalid`),
    );
    assert.deepEqual(result.requests, []);
  }
});

for (const action of ["promote", "rollback"]) {
  test(`asks the broker to ${action} the staged rollout and reports the result`, () => {
    const result = run({ ...validInputs, INPUT_ACTION: action }, [
      { status: 200, body: { value: "oidc-token" } },
      { status: 200, body: brokerResult(action) },
    ]);
    assert.equal(result.status, 0, result.stderr);
    const [token, broker] = result.requests;
    assert.equal(
      new URL(token.url).searchParams.get("audience"),
      "cf.tempoxyz.net",
    );
    assert.equal(broker.url, "https://cf.tempoxyz.net/v1/deploy");
    assert.equal(broker.headers.authorization, "Bearer oidc-token");
    assert.deepEqual(JSON.parse(broker.body), {
      operation: action,
      deploymentId: "example-worker",
      operationId,
      commitSha: "c".repeat(40),
      runId: "1",
    });
    assert.deepEqual(result.outputs, {
      "operation-id": operationId,
      state: action === "promote" ? "promoted" : "rolled_back",
      "version-id":
        action === "promote" ? candidateVersionId : stableVersionId,
      "deployment-id": deploymentId,
      "stable-version-id": stableVersionId,
      "candidate-version-id": candidateVersionId,
      changed: "true",
    });
  });
}

test("rejects a broker result for another rollout or action", () => {
  for (const changes of [
    { operationId: "55555555-5555-4555-8555-555555555555" },
    { action: "rollback" },
    { versionId: stableVersionId },
    { changed: "yes" },
  ]) {
    const result = run(validInputs, [
      { status: 200, body: { value: "oidc-token" } },
      { status: 200, body: brokerResult("promote", changes) },
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not contain a valid promote/);
    assert.deepEqual(result.outputs, {});
  }
});

test("reports the broker's refusal by code", () => {
  const result = run(validInputs, [
    { status: 200, body: { value: "oidc-token" } },
    {
      status: 409,
      body: {
        error: "rollout_diverged",
        message:
          "the Worker was deployed after this rollout was staged; start a new deployment",
      },
    },
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /promotion failed \(HTTP 409\) \[rollout_diverged\]/,
  );
});
