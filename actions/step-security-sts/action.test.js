const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { endpoint, rateLimitDelay, retry, retryRateLimited } = require("./http.cjs");
const { publishToken, retryExchange } = require("./main.cjs");
const { buildRevokeRequest } = require("./post.cjs");

const stsHost = "ss-sts.tempoxyz.net";
const leaseId = "11111111-1111-4111-8111-111111111111";

test("accepts the supported development and production hosts", () => {
  assert.deepEqual(endpoint(stsHost), {
    audience: stsHost,
    origin: `https://${stsHost}`,
  });
  assert.deepEqual(endpoint("ss-sts.tehq.dev"), {
    audience: "ss-sts.tehq.dev",
    origin: "https://ss-sts.tehq.dev",
  });
  for (const value of ["ss-sts.tehq.net", "https://ss-sts.tempoxyz.net", "sts.example.test"]) {
    assert.throws(() => endpoint(value), /host must be/);
  }

  for (const filename of ["action.yml", "http.cjs", "main.cjs", "post.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, filename), "utf8");
    assert.doesNotMatch(source, /tehq\.net|workers\.dev/);
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

test("retries every 5xx exchange response with exponential backoff", async () => {
  const delays = [];
  const statuses = Array.from({ length: 100 }, (_, index) => 500 + index);
  for (const status of statuses) {
    let attempts = 0;
    const response = await retryExchange(
      async () => ({ status: ++attempts < 4 ? status : 200 }),
      { sleep: async (delay) => delays.push(delay) },
    );
    assert.equal(response.status, 200);
    assert.equal(attempts, 4);
  }
  assert.deepEqual(delays, statuses.flatMap(() => [1000, 2000, 4000]));
});

test("does not retry a non-transient exchange response", async () => {
  let attempts = 0;
  const response = await retryExchange(
    async () => {
      attempts += 1;
      return { status: 403 };
    },
    { sleep: async () => { throw new Error("unexpected retry"); } },
  );
  assert.equal(response.status, 403);
  assert.equal(attempts, 1);
});

test("passes 429 to the rate-limit handler without an inner retry", async () => {
  const delays = [];
  let attempts = 0;
  const response = await retryExchange(
    async () => ++attempts === 1
      ? { status: 429, headers: { "retry-after": "3" } }
      : { status: 200 },
    { now: () => 0, sleep: async (delay) => delays.push(delay) },
  );
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [3000]);
});

test("honors an STS Retry-After response before retrying", async () => {
  let attempts = 0;
  const delays = [];
  const response = await retryRateLimited(
    async () => {
      attempts += 1;
      return attempts === 1
        ? { status: 429, headers: { "retry-after": "3" }, body: "" }
        : { status: 200, headers: {}, body: "recovered" };
    },
    { now: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [3_000]);
  assert.equal(
    rateLimitDelay({ status: 429, headers: {}, body: '{"retry_after":5}' }, 0),
    5_000,
  );
});

test("fails instead of waiting more than two minutes for an STS rate limit", async () => {
  await assert.rejects(
    retryRateLimited(
      async () => ({
        status: 429,
        headers: { "retry-after": "121" },
        body: "",
      }),
      { now: () => 0, sleep: async () => {} },
    ),
    /exceeds the 2 minute limit/,
  );
});

test("main fails closed without an STS host", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_HOST: "",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /INPUT_HOST is missing/,
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

test("closes STS leases through the selected host", () => {
  const token = "step_test_short_lived_api_key";
  const revoke = buildRevokeRequest(token, leaseId, stsHost);

  assert.equal(revoke.url, `https://${stsHost}/sts/exchange`);
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
