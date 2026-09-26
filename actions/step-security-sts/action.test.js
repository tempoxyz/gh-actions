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
      { random: () => 0, sleep: async (delay) => delays.push(delay) },
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

test("fails instead of waiting past the rate-limit budget", async () => {
  await assert.rejects(
    retryRateLimited(
      async () => ({
        status: 429,
        headers: { "retry-after": "121" },
        body: "",
      }),
      { now: () => 0, sleep: async () => {} },
    ),
    /exceeds the remaining retry budget \(120s\)/,
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

const { exchangeToken } = require("./main.cjs");

const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
};
const oidcIssued = {
  status: 200,
  headers: {},
  body: JSON.stringify({ value: "oidc-assertion" }),
};
const leaseIssued = {
  status: 200,
  headers: {},
  body: JSON.stringify({
    token: "step_test_short_lived_api_key",
    expires_at: "2026-09-25T00:00:00Z",
    lease_id: leaseId,
  }),
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
        random: () => 0,
      }),
  };
}

test("exchangeToken returns the minted lease", async () => {
  const { attempts, exchange } = scriptedExchange({ sts: [leaseIssued] });
  assert.deepEqual(await exchange(), {
    token: "step_test_short_lived_api_key",
    expiresAt: "2026-09-25T00:00:00Z",
    leaseId,
    rawHost: stsHost,
  });
  assert.deepEqual(attempts, { oidc: 1, sts: 1 });
});

test("STS failures that persist through every retry name the final failure", async () => {
  const cases = [
    {
      name: "5xx on every attempt",
      sts: [{ status: 503, headers: {}, body: "" }],
      message: "Step Security STS exchange failed (HTTP 503)",
      attempts: 4,
    },
    {
      name: "connection timeout on every attempt",
      sts: [new Error("HTTPS request timed out")],
      message: "Step Security STS exchange failed: HTTPS request timed out",
      attempts: 4,
    },
    {
      name: "connection failure on every attempt",
      sts: [new Error("HTTPS request failed")],
      message: "Step Security STS exchange failed: HTTPS request failed",
      attempts: 4,
    },
    {
      name: "429 whose Retry-After exceeds the wait budget",
      sts: [{ status: 429, headers: { "retry-after": "121" }, body: "" }],
      message:
        "Step Security STS exchange failed: Rate limit retry delay (121s) exceeds the remaining retry budget (90s)",
      attempts: 1,
    },
    {
      name: "unparseable success response",
      sts: [{ status: 200, headers: {}, body: "<html>upstream error</html>" }],
      message: "Step Security STS response is invalid",
      attempts: 1,
    },
  ];
  for (const { name, sts, message, attempts: expected } of cases) {
    const { attempts, exchange } = scriptedExchange({ sts });
    await assert.rejects(exchange(), { name: "Error", message }, name);
    assert.equal(attempts.sts, expected, name);
  }
});

test("transient STS failures that recover within the retries still mint a lease", async () => {
  const { attempts, exchange } = scriptedExchange({
    sts: [
      new Error("HTTPS request timed out"),
      { status: 502, headers: {}, body: "" },
      { status: 429, headers: { "retry-after": "1" }, body: "" },
      leaseIssued,
    ],
  });
  assert.equal((await exchange()).token, "step_test_short_lived_api_key");
  assert.equal(attempts.sts, 4);
});

test("definitive STS rejections fail after a single attempt with the server's message", async () => {
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
    await assert.rejects(
      exchange(),
      {
        name: "Error",
        message: `Step Security STS exchange failed (HTTP ${status}): repository is not authorized`,
      },
      `HTTP ${status}`,
    );
    assert.equal(attempts.sts, 1, `HTTP ${status}`);
  }
});

test("GitHub OIDC issuer failures name the issuer and stop before the STS", async () => {
  const cases = [
    {
      name: "5xx on every attempt",
      oidc: [{ status: 503, headers: {}, body: "" }],
      message: "GitHub OIDC request failed (HTTP 503)",
      attempts: 4,
    },
    {
      name: "timeout on every attempt",
      oidc: [new Error("HTTPS request timed out")],
      message: "GitHub OIDC request failed: HTTPS request timed out",
      attempts: 4,
    },
    {
      name: "malformed issuer response",
      oidc: [{ status: 200, headers: {}, body: "{}" }],
      message: "GitHub OIDC response is invalid",
      attempts: 1,
    },
    {
      name: "definitive issuer rejection",
      oidc: [{ status: 401, headers: {}, body: "" }],
      message: "GitHub OIDC request failed (HTTP 401)",
      attempts: 1,
    },
  ];
  for (const { name, oidc, message, attempts: expected } of cases) {
    const { attempts, exchange } = scriptedExchange({ oidc });
    await assert.rejects(exchange(), { name: "Error", message }, name);
    assert.deepEqual(attempts, { oidc: expected, sts: 0 }, name);
  }
});

const { JITTER_RATIO, RETRY_BUDGET_MS } = require("./http.cjs");

test("backoff carries up to 25% jitter", async () => {
  assert.equal(JITTER_RATIO, 0.25);
  const delays = [];
  let attempts = 0;
  const response = await retryExchange(
    async () => ({ status: ++attempts < 4 ? 503 : 200 }),
    { random: () => 1, sleep: async (delay) => delays.push(delay) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [1250, 2500, 5000]);
});

test("one 90-second budget bounds the whole exchange, including rate-limit waits and request timeouts", async () => {
  assert.equal(RETRY_BUDGET_MS, 90_000);
  let clock = 0;
  const timeouts = [];
  let attempts = 0;
  const rateLimited = async (url, options) => {
    if (String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL)) return oidcIssued;
    attempts += 1;
    timeouts.push(options.timeoutMs);
    return { status: 429, headers: { "retry-after": "60" }, body: "" };
  };
  await assert.rejects(
    exchangeToken(stsHost, {
      env: oidcEnv,
      request: rateLimited,
      now: () => clock,
      sleep: async (delay) => {
        clock += delay;
      },
      random: () => 0,
    }),
    {
      name: "Error",
      message:
        "Step Security STS exchange failed: Rate limit retry delay (60s) exceeds the remaining retry budget (30s)",
    },
  );
  assert.equal(attempts, 2, "the first 60s wait fits the budget; the second does not");
  assert.equal(clock, 60_000);
  assert.deepEqual(timeouts, [10_000, 10_000]);

  // Each request's timeout shrinks to whatever budget is left.
  const shortTimeouts = [];
  const quick = async (url, options) => {
    shortTimeouts.push(options.timeoutMs);
    return String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL) ? oidcIssued : leaseIssued;
  };
  await exchangeToken(stsHost, { env: oidcEnv, request: quick, now: () => 0, sleep: async () => {}, budgetMs: 4_000 });
  assert.deepEqual(shortTimeouts, [4_000, 4_000]);

  // Transport failures that outlast the budget surface as the transport failure.
  let elapsed = 0;
  await assert.rejects(
    exchangeToken(stsHost, {
      env: oidcEnv,
      request: async (url) => {
        if (String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL)) return oidcIssued;
        elapsed += 10_000;
        throw new Error("HTTPS request timed out");
      },
      now: () => elapsed,
      sleep: async (delay) => {
        elapsed += delay;
      },
      random: () => 0,
      budgetMs: 25_000,
    }),
    { message: "Step Security STS exchange failed: HTTPS request timed out" },
  );
  assert.ok(elapsed <= 25_000 + 10_000, `stopped near the budget, elapsed ${elapsed}ms`);
});

const { main: postMain } = require("./post.cjs");

function capture(callback) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      console.log = original;
    })
    .then((value) => ({ value, lines }));
}

test("post reports a failed lease revocation as a warning instead of failing the job", async () => {
  const state = {
    STATE_token: "step_test_short_lived_api_key",
    STATE_lease_id: leaseId,
    STATE_sts_host: stsHost,
  };
  const cases = [
    {
      name: "5xx after retries",
      request: async () => ({ status: 503, headers: {}, body: "" }),
      expected: /^::warning title=Step Security STS lease revocation failed::The Step Security STS answered HTTP 503 when closing the lease\. The lease expires on its own\.$/,
      attempts: 4,
    },
    {
      name: "transport failure after retries",
      request: async () => {
        throw new Error("HTTPS request timed out");
      },
      expected: /^::warning title=Step Security STS lease revocation failed::Could not reach the Step Security STS to close the lease: HTTPS request timed out\. The lease expires on its own\.$/,
      attempts: 4,
    },
    {
      name: "definitive rejection",
      request: async () => ({ status: 404, headers: {}, body: "" }),
      expected: /^::warning title=Step Security STS lease revocation failed::The Step Security STS answered HTTP 404/,
      attempts: 1,
    },
  ];
  for (const { name, request, expected, attempts } of cases) {
    let calls = 0;
    const { lines } = await capture(() =>
      postMain({
        env: state,
        request: async (...args) => {
          calls += 1;
          return request(...args);
        },
        sleep: async () => {},
      }),
    );
    assert.equal(calls, attempts, name);
    const warnings = lines.filter((line) => line.startsWith("::warning"));
    assert.equal(warnings.length, 1, `${name}: ${lines.join("\n")}`);
    assert.match(warnings[0], expected, name);
  }

  const ok = await capture(() =>
    postMain({ env: state, request: async () => ({ status: 204, headers: {}, body: "" }) }),
  );
  assert.deepEqual(ok.lines, ["Step Security STS lease closed."]);

  // Corrupt state means this action misbehaved earlier and still fails the job.
  await assert.rejects(
    postMain({ env: { ...state, STATE_token: "short" }, request: async () => assert.fail("no request") }),
    /API key is invalid/,
  );
  await assert.rejects(
    postMain({ env: { ...state, STATE_lease_id: "nope" }, request: async () => assert.fail("no request") }),
    /lease ID is invalid/,
  );
});

test("exchangeToken uses an injected OIDC provider for the STS audience instead of fetching its own", async () => {
  const audiences = [];
  const calls = [];
  const result = await exchangeToken(stsHost, {
    env: {},
    getOidc: async (audience) => {
      audiences.push(audience);
      return "injected-assertion";
    },
    request: async (url, options) => {
      calls.push([String(url), options.headers.authorization]);
      return leaseIssued;
    },
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(result.token, "step_test_short_lived_api_key");
  assert.deepEqual(audiences, [stsHost]);
  assert.deepEqual(calls, [[`https://${stsHost}/sts/exchange`, "Bearer injected-assertion"]]);

  await assert.rejects(
    exchangeToken(stsHost, { env: {}, getOidc: async () => "", request: async () => leaseIssued }),
    /GitHub OIDC response is invalid/,
  );
});
