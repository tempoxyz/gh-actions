const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { endpoint, retry } = require("./http.cjs");
const { publishToken } = require("./main.cjs");
const { buildRevokeRequest } = require("./post.cjs");

const secretUrl = "https://sts.example.test";
const leaseId = "11111111-1111-4111-8111-111111111111";

test("uses a validated secret endpoint without embedding deployment hosts", () => {
  assert.deepEqual(endpoint(secretUrl), {
    audience: "sts.example.test",
    origin: secretUrl,
  });
  for (const value of [
    "http://sts.example.test",
    "https://user@sts.example.test",
    "https://sts.example.test:8443",
    "https://sts.example.test/path",
    "https://sts.example.test?query=1",
    "https://sts.example.test/#fragment",
  ]) {
    assert.throws(() => endpoint(value), /STS URL is invalid/);
  }

  for (const filename of [
    "action.yml",
    "http.cjs",
    "main.cjs",
    "post.cjs",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, filename), "utf8");
    assert.doesNotMatch(source, /tehq\.|workers\.dev/);
  }
});

test("retries transient exchange responses", async () => {
  let attempts = 0;
  const response = await retry(
    async () => {
      attempts += 1;
      if (attempts === 1) return { status: 502, body: "upstream failure" };
      return { status: 200, body: "recovered" };
    },
    { sleep: async () => {} },
  );

  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
});

test("main fails closed without the secret STS URL", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      "INPUT_STS-URL": "",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /INPUT_STS-URL is missing/,
  );
});

test("masks the token before publishing it as output or state", () => {
  const calls = [];
  const originalAppendFileSync = fs.appendFileSync;
  const originalLog = console.log;
  const originalOutput = process.env.GITHUB_OUTPUT;
  const originalState = process.env.GITHUB_STATE;
  fs.appendFileSync = (file, value) => calls.push(["append", file, value]);
  console.log = (value) => calls.push(["log", value]);
  process.env.GITHUB_OUTPUT = "github-output";
  process.env.GITHUB_STATE = "github-state";

  try {
    publishToken(
      "step%key-with-sensitive-value",
      "2026-09-06T03:00:00Z",
      leaseId,
    );
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    console.log = originalLog;
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    if (originalState === undefined) delete process.env.GITHUB_STATE;
    else process.env.GITHUB_STATE = originalState;
  }

  assert.deepEqual(calls, [
    ["log", "::add-mask::step%25key-with-sensitive-value"],
    ["append", "github-output", "token=step%key-with-sensitive-value\n"],
    ["append", "github-output", "expires-at=2026-09-06T03:00:00Z\n"],
    ["append", "github-state", "token=step%key-with-sensitive-value\n"],
    ["append", "github-state", `lease_id=${leaseId}\n`],
  ]);
});

test("closes STS leases through the secret endpoint", () => {
  const token = "step_test_short_lived_api_key";
  const revoke = buildRevokeRequest(token, leaseId, secretUrl);

  assert.equal(revoke.url, `${secretUrl}/sts/exchange`);
  assert.equal(revoke.options.method, "DELETE");
  assert.equal(revoke.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(revoke.body), { token, lease_id: leaseId });
});

test("post is a no-op when no API key was minted", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /skipping revocation/);
});
