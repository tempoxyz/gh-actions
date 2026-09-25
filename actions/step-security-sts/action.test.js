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

test("accepts a hostname and rejects URL components", () => {
  assert.deepEqual(endpoint(stsHost), {
    audience: stsHost,
    origin: `https://${stsHost}`,
  });
  assert.deepEqual(endpoint("sts.example.test"), {
    audience: "sts.example.test",
    origin: "https://sts.example.test",
  });
  for (const value of ["", "https://ss-sts.tempoxyz.net", "ss-sts.tempoxyz.net:443", "ss-sts.tempoxyz.net/path"]) {
    assert.throws(() => endpoint(value), /host must be a hostname/);
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

const { StsUnavailableError, exchangeToken } = require("./main.cjs");

const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
};
const oidcIssued = {
  status: 200,
  headers: {},
  body: JSON.stringify({ value: "oidc-assertion" }),
};

// Drives exchangeToken against scripted responses. Each leg replays its final
// entry once the script runs out, so a single 503 means "503 on every retry".
function scriptedExchange({ oidc = [oidcIssued], sts = [] }) {
  const attempts = { oidc: 0, sts: 0 };
  const next = (leg, script) => {
    const entry = script[Math.min(attempts[leg], script.length - 1)];
    attempts[leg] += 1;
    if (entry instanceof Error) throw entry;
    return entry;
  };
  const request = async (url) =>
    String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL)
      ? next("oidc", oidc)
      : next("sts", sts);
  return {
    attempts,
    exchange: () =>
      exchangeToken(stsHost, {
        env: oidcEnv,
        request,
        sleep: async () => {},
        now: () => 0,
      }),
  };
}

test("exchangeToken returns the minted lease", async () => {
  const { attempts, exchange } = scriptedExchange({
    sts: [
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          token: "step_test_short_lived_api_key",
          expires_at: "2026-09-25T00:00:00Z",
          lease_id: leaseId,
        }),
      },
    ],
  });
  assert.deepEqual(await exchange(), {
    token: "step_test_short_lived_api_key",
    expiresAt: "2026-09-25T00:00:00Z",
    leaseId,
    rawHost: stsHost,
  });
  assert.deepEqual(attempts, { oidc: 1, sts: 1 });
});

test("STS failures that persist through every retry are reported as unavailability", async () => {
  const cases = [
    {
      name: "5xx on every attempt",
      sts: [{ status: 503, headers: {}, body: "" }],
      message: /Step Security STS exchange failed \(HTTP 503\)/,
      attempts: 4,
    },
    {
      name: "connection timeout on every attempt",
      sts: [new Error("HTTPS request timed out")],
      message: /Step Security STS exchange failed: HTTPS request timed out/,
      attempts: 4,
    },
    {
      name: "connection failure on every attempt",
      sts: [new Error("HTTPS request failed")],
      message: /Step Security STS exchange failed: HTTPS request failed/,
      attempts: 4,
    },
    {
      name: "429 whose Retry-After exceeds the wait budget",
      sts: [{ status: 429, headers: { "retry-after": "121" }, body: "" }],
      message: /Step Security STS exchange failed: Rate limit retry delay \(121s\) exceeds the 2 minute limit/,
      attempts: 1,
    },
    {
      name: "unparseable success response",
      sts: [{ status: 200, headers: {}, body: "<html>upstream error</html>" }],
      message: /Step Security STS response is invalid/,
      attempts: 1,
    },
  ];
  for (const { name, sts, message, attempts: expected } of cases) {
    const { attempts, exchange } = scriptedExchange({ sts });
    await assert.rejects(
      exchange(),
      { name: "StsUnavailableError", message },
      name,
    );
    assert.equal(attempts.sts, expected, name);
  }
});

test("transient STS failures that recover within the retries still mint a lease", async () => {
  const { attempts, exchange } = scriptedExchange({
    sts: [
      new Error("HTTPS request timed out"),
      { status: 502, headers: {}, body: "" },
      { status: 429, headers: { "retry-after": "1" }, body: "" },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          token: "step_test_short_lived_api_key",
          expires_at: "2026-09-25T00:00:00Z",
          lease_id: leaseId,
        }),
      },
    ],
  });
  assert.equal((await exchange()).token, "step_test_short_lived_api_key");
  assert.equal(attempts.sts, 4);
});

test("definitive STS rejections are not unavailability", async () => {
  for (const status of [400, 401, 403, 404]) {
    const { attempts, exchange } = scriptedExchange({
      sts: [
        {
          status,
          headers: {},
          body: JSON.stringify({ message: "repository is not\nauthorized" }),
        },
      ],
    });
    const error = await exchange().then(
      () => assert.fail("expected the exchange to fail"),
      (caught) => caught,
    );
    assert.ok(!(error instanceof StsUnavailableError), `HTTP ${status}`);
    assert.equal(error.name, "Error");
    assert.match(
      error.message,
      new RegExp(`Step Security STS exchange failed \\(HTTP ${status}\\): repository is not authorized`),
    );
    assert.equal(attempts.sts, 1, `HTTP ${status}`);
  }
});

test("GitHub OIDC issuer failures follow the same classification", async () => {
  const unavailable = [
    {
      name: "5xx on every attempt",
      oidc: [{ status: 503, headers: {}, body: "" }],
      message: /GitHub OIDC request failed \(HTTP 503\)/,
    },
    {
      name: "timeout on every attempt",
      oidc: [new Error("HTTPS request timed out")],
      message: /GitHub OIDC request failed: HTTPS request timed out/,
    },
    {
      name: "malformed issuer response",
      oidc: [{ status: 200, headers: {}, body: "{}" }],
      message: /GitHub OIDC response is invalid/,
    },
  ];
  for (const { name, oidc, message } of unavailable) {
    const { attempts, exchange } = scriptedExchange({ oidc });
    await assert.rejects(exchange(), { name: "StsUnavailableError", message }, name);
    assert.equal(attempts.sts, 0, name);
  }

  const { attempts, exchange } = scriptedExchange({
    oidc: [{ status: 401, headers: {}, body: "" }],
  });
  await assert.rejects(exchange(), {
    name: "Error",
    message: /GitHub OIDC request failed \(HTTP 401\)/,
  });
  assert.deepEqual(attempts, { oidc: 1, sts: 0 });
});
