const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_BROKER_HOST,
  brokerAudience,
  brokerEndpoint,
  brokerHost,
} = require("./endpoint.cjs");
const { brokerFailureMessage } = require("./error.cjs");

test("selects the broker endpoint and OIDC audience for the host", () => {
  for (const [host, endpoint, audience] of [
    ["", "https://cf.tempoxyz.net/", "cf.tempoxyz.net"],
    ["broker.example.com", "https://broker.example.com/", "broker.example.com"],
  ]) {
    assert.equal(brokerEndpoint(host).href, endpoint);
    assert.equal(brokerAudience(host), audience);
  }
});

test("defaults an omitted host and rejects non-hostname values", () => {
  assert.equal(brokerHost(""), DEFAULT_BROKER_HOST);
  for (const host of [
    "https://example.com",
    "example.com:443",
    "example.com/path",
    "UPPER.example.com",
    "localhost",
  ]) {
    assert.throws(() => brokerEndpoint(host), /lowercase DNS hostname/);
    assert.throws(() => brokerAudience(host), /lowercase DNS hostname/);
  }
});

test("exposes only a hostname override with the production default", () => {
  const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const main = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.ok(action.includes("  host:"));
  assert.ok(action.includes('default: "cf.tempoxyz.net"'));
  assert.ok(main.includes('input("host")'));
  for (const removed of [
    "  dev:",
    "INPUT_DEV",
    "  endpoint:",
    "INPUT_ENDPOINT",
    "bootstrap-secrets-json",
    "INPUT_BOOTSTRAP_SECRETS_JSON",
  ])
    assert.ok(!action.includes(removed), removed);
  assert.ok(main.includes('new URL("/v1/deploy", endpoint)'));
  assert.ok(main.includes("oidc(audience)"));
  assert.ok(!main.includes("oidc(endpoint.hostname)"));
});

test("runs on the runner's Node.js without changing the job's PATH", () => {
  const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
  assert.match(action, /\nruns:\n  using: node24\n  main: main\.cjs\n$/);
  assert.ok(!action.includes("setup-node"));
  assert.ok(!action.includes("value: ${{"));
});

function runMain(env) {
  return spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

const validInputs = {
  "INPUT_DEPLOYMENT-ID": "example-worker",
  "INPUT_ARTIFACT-ID": "123",
  "INPUT_ARCHIVE-DIGEST": "a".repeat(64),
  "INPUT_MODULE-DIGEST": "b".repeat(64),
  INPUT_HOST: "",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: "c".repeat(40),
};

test("reads the runner's hyphenated input names", () => {
  // Inputs are read first, so a missing repository is the first failure only
  // when every input was found. It also fails before any network request.
  const result = runMain(validInputs);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GITHUB_REPOSITORY is missing or invalid/);
});

test("names the invalid input", () => {
  const result = runMain({
    ...validInputs,
    "INPUT_DEPLOYMENT-ID": "Not Valid",
    GITHUB_REPOSITORY: "tempoxyz/example",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment-id is missing or invalid/);
});

test("identifies every broker failure by operation, status, code, and safe message", () => {
  assert.equal(
    brokerFailureMessage("deployment", 403, {
      error: "artifact_configuration_mismatch",
      message:
        "D1 binding `DB` to database `c733fe15-460a-4b37-b959-c6da4e717a8e` is not authorized\nby policy.",
    }),
    "Cloudflare Deploy Broker deployment failed (HTTP 403) [artifact_configuration_mismatch]: D1 binding `DB` to database `c733fe15-460a-4b37-b959-c6da4e717a8e` is not authorized by policy.",
  );
  assert.equal(
    brokerFailureMessage("cleanup", 502, {}),
    "Cloudflare Deploy Broker cleanup failed (HTTP 502)",
  );
});

const crypto = require("node:crypto");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");

function runWithBroker(env, responses) {
  const directory = mkdtempSync(path.join(tmpdir(), "broker-deploy-"));
  const capture = path.join(directory, "requests.jsonl");
  const outputs = path.join(directory, "outputs");
  writeFileSync(capture, "");
  writeFileSync(outputs, "");
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      path.join(__dirname, "../../testdata/cloudflare-deploy-broker/fake-https.cjs"),
      path.join(__dirname, "main.cjs"),
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/oidc",
        GITHUB_OUTPUT: outputs,
        GITHUB_REPOSITORY: "tempoxyz/example",
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

const deployed = {
  operationId: "44444444-4444-4444-8444-444444444444",
  policyDigest: "e".repeat(64),
  normalizedArtifactDigest: "b".repeat(64),
  workerName: "example-worker",
  workerTag: "f".repeat(32),
  versionId: "11111111-1111-4111-8111-111111111111",
  deploymentId: "66666666-6666-4666-8666-666666666666",
  verificationUrl: "https://example-worker.tempoxyz.net",
  verified: true,
};

test("names an invalid promotion before any request", () => {
  const result = runWithBroker(
    { ...validInputs, INPUT_PROMOTION: "gradual" },
    [],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /promotion is missing or invalid/);
  assert.deepEqual(result.requests, []);
});

test("keeps the immediate request body and idempotency key unchanged", () => {
  const result = runWithBroker(validInputs, [
    { status: 200, body: { value: "oidc-token" } },
    { status: 201, body: deployed },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.requests[1].body);
  assert.equal(body.promotion, undefined);
  assert.equal(
    body.idempotencyKey,
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          repository: "tempoxyz/example",
          runId: "1",
          runAttempt: "1",
          deploymentId: "example-worker",
          artifactId: "123",
          archiveSha256: "a".repeat(64),
          moduleSha256: "b".repeat(64),
          commitSha: "c".repeat(40),
        }),
      )
      .digest("hex"),
  );
  assert.equal(result.outputs["stable-version-id"], "");
  assert.equal(result.outputs["version-id"], deployed.versionId);
});

test("stages a candidate and reports the version that keeps serving", () => {
  const stableVersionId = "00000000-0000-4000-8000-000000000000";
  const result = runWithBroker({ ...validInputs, INPUT_PROMOTION: "staged" }, [
    { status: 200, body: { value: "oidc-token" } },
    { status: 201, body: { ...deployed, staged: { stableVersionId } } },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.requests[1].body);
  assert.equal(body.promotion, "staged");
  // A staged request never shares an immediate request's idempotency key.
  const immediate = runWithBroker(validInputs, [
    { status: 200, body: { value: "oidc-token" } },
    { status: 201, body: deployed },
  ]);
  assert.notEqual(
    body.idempotencyKey,
    JSON.parse(immediate.requests[1].body).idempotencyKey,
  );
  assert.equal(result.outputs["stable-version-id"], stableVersionId);
  assert.equal(result.outputs["version-id"], deployed.versionId);
  assert.equal(result.outputs["operation-id"], deployed.operationId);
  assert.match(result.stdout, /Staged example-worker version/);
});

test("fails when a staged request was not staged, or an immediate one was", () => {
  for (const [promotion, body] of [
    ["staged", deployed],
    [
      "immediate",
      {
        ...deployed,
        staged: { stableVersionId: "00000000-0000-4000-8000-000000000000" },
      },
    ],
  ]) {
    const result = runWithBroker(
      { ...validInputs, INPUT_PROMOTION: promotion },
      [
        { status: 200, body: { value: "oidc-token" } },
        { status: 201, body },
      ],
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /staged the version|did not stage/);
    assert.deepEqual(result.outputs, {});
  }
});
