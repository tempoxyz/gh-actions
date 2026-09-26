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

const { exchangeToken, main: stsMain } = require("./main.cjs");

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
const { ServiceDisabledError, isServiceDisabled, parseStatus, serviceStatus } = require("./status.cjs");

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
const statusEnabled = { status: 200, headers: {}, body: JSON.stringify({ status: "enabled" }) };
const statusDisabled = {
  status: 200,
  headers: {},
  body: JSON.stringify({ status: "disabled", reason: "Paused" }),
};
const isStatusProbe = (url) => String(url).endsWith("/status");

// Drives exchangeToken against scripted responses. Each leg replays its final
// entry once the script runs out, so a single 503 means "503 on every retry".
function scriptedExchange({ oidc = [oidcIssued], status = [statusEnabled], sts = [] }) {
  const attempts = { oidc: 0, status: 0, sts: 0 };
  const next = (leg, script) => {
    const entry = script[Math.min(attempts[leg], script.length - 1)];
    attempts[leg] += 1;
    if (entry instanceof Error) throw entry;
    return entry;
  };
  const request = async (url) =>
    String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL)
      ? next("oidc", oidc)
      : isStatusProbe(url)
        ? next("status", status)
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
  assert.deepEqual(attempts, { oidc: 1, status: 1, sts: 1 });
});

test("a disabled STS fails the exchange with its reason before any OIDC or exchange request", async () => {
  const { attempts, exchange } = scriptedExchange({ status: [statusDisabled], sts: [leaseIssued] });
  await assert.rejects(exchange(), (error) => {
    assert.equal(error.name, "ServiceDisabledError");
    assert.equal(error.code, "ESTS_SERVICE_DISABLED");
    assert.equal(isServiceDisabled(error), true);
    assert.deepEqual([error.service, error.host, error.reason], ["Step Security STS", stsHost, "Paused"]);
    assert.equal(error.message, `Step Security STS at ${stsHost} is disabled: Paused`);
    return true;
  });
  assert.deepEqual(attempts, { oidc: 0, status: 1, sts: 0 });
});

test("an inconclusive status probe never blocks the exchange", async () => {
  const inconclusive = [
    ["HTTP 404", { status: 404, headers: {}, body: "Not found" }],
    ["Access redirect", { status: 302, headers: { location: "https://access.example/login" }, body: "" }],
    ["HTTP 503", { status: 503, headers: {}, body: JSON.stringify({ message: "service unavailable" }) }],
    ["invalid JSON", { status: 200, headers: {}, body: "<html>" }],
    ["unknown status", { status: 200, headers: {}, body: JSON.stringify({ status: "draining" }) }],
    ["array body", { status: 200, headers: {}, body: "[]" }],
    ["transport failure", new Error("HTTPS request failed")],
    ["timeout", new Error("HTTPS request timed out")],
  ];
  for (const [name, response] of inconclusive) {
    const { attempts, exchange } = scriptedExchange({ status: [response], sts: [leaseIssued] });
    const { value, lines } = await capture(exchange);
    assert.equal(value.token, "step_test_short_lived_api_key", name);
    assert.deepEqual(attempts, { oidc: 1, status: 1, sts: 1 }, name);
    assert.equal(lines.length, 1, name);
    assert.match(lines[0], /^Step Security STS status check was inconclusive \(.+\); continuing with the exchange\.$/, name);
    assert.doesNotMatch(lines[0], /^::/, name);
  }
  // A recognized answer says nothing.
  const { lines } = await capture(scriptedExchange({ sts: [leaseIssued] }).exchange);
  assert.deepEqual(lines, []);
});

test("the status probe is one empty POST bounded by the remaining budget", async () => {
  const calls = [];
  const record = async (url, options) => {
    calls.push([String(url), options.method, options.headers, options.timeoutMs]);
    return statusEnabled;
  };
  assert.deepEqual(await serviceStatus(`https://${stsHost}`, { request: record, now: () => 0 }), { status: "enabled" });
  assert.deepEqual(calls, [[
    `https://${stsHost}/status`,
    "POST",
    { accept: "application/json", "content-length": "0", "user-agent": "tempoxyz-step-security-sts-action" },
    10_000,
  ]]);
  calls.length = 0;
  await serviceStatus(`https://${stsHost}`, { request: record, now: () => 86_000, deadline: 90_000 });
  assert.equal(calls[0][3], 4_000, "shrinks to what is left of the budget");
  calls.length = 0;
  assert.equal(await serviceStatus(`https://${stsHost}`, { request: record, now: () => 90_000, deadline: 90_000 }), null);
  assert.deepEqual(calls, [], "no request once the budget is spent");

  // The reason is reduced to one printable line for the annotation.
  assert.deepEqual(parseStatus(JSON.stringify({ status: "disabled", reason: " Paused\r\n by  ops\u0000 " })), { status: "disabled", reason: "Paused by ops" });
  assert.deepEqual(parseStatus(JSON.stringify({ status: "disabled" })), { status: "disabled", reason: "no reason given" });
  assert.deepEqual(parseStatus(JSON.stringify({ status: "disabled", reason: "x".repeat(300) })), { status: "disabled", reason: "x".repeat(200) });
  assert.deepEqual(parseStatus(JSON.stringify({ status: "enabled", reason: "ignored" })), { status: "enabled" });
  for (const body of ["null", "1", '"enabled"', "{}", '{"status":"ENABLED"}', "not json"]) {
    assert.equal(parseStatus(body), null, body);
  }
});

test("main reports a disabled STS as a warning, mirrors it to the step summary, and still fails", async () => {
  const summary = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sts-status-")), "summary");
  const env = { ...oidcEnv, INPUT_HOST: stsHost, GITHUB_STEP_SUMMARY: summary };
  const disabled = new ServiceDisabledError("Step Security STS", stsHost, "Paused");
  const { lines } = await capture(async () => {
    await assert.rejects(stsMain({ env, exchange: async () => { throw disabled; } }), disabled);
  });
  const message =
    `The Step Security STS at ${stsHost} is disabled: Paused. No policy-store credential was issued to this job.`;
  assert.deepEqual(lines, [`::warning title=Step Security STS disabled::${message}`]);
  assert.equal(fs.readFileSync(summary, "utf8"), `> ⚠️ **Step Security STS disabled:** ${message}\n`);

  // Other failures are not annotated here; they fail the step as before.
  const { lines: quiet } = await capture(async () => {
    await assert.rejects(stsMain({ env, exchange: async () => { throw new Error("Step Security STS exchange failed (HTTP 503)"); } }), /HTTP 503/);
  });
  assert.deepEqual(quiet, []);
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
    assert.deepEqual(attempts, { oidc: expected, status: 1, sts: 0 }, name);
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
    if (isStatusProbe(url)) return statusEnabled;
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

  // Each request's timeout, the status probe's included, shrinks to whatever
  // budget is left.
  const shortTimeouts = [];
  const quick = async (url, options) => {
    shortTimeouts.push(options.timeoutMs);
    if (isStatusProbe(url)) return statusEnabled;
    return String(url).startsWith(oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL) ? oidcIssued : leaseIssued;
  };
  await exchangeToken(stsHost, { env: oidcEnv, request: quick, now: () => 0, sleep: async () => {}, budgetMs: 4_000 });
  assert.deepEqual(shortTimeouts, [4_000, 4_000, 4_000]);

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
      return isStatusProbe(url) ? statusEnabled : leaseIssued;
    },
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(result.token, "step_test_short_lived_api_key");
  assert.deepEqual(audiences, [stsHost]);
  assert.deepEqual(calls, [
    [`https://${stsHost}/status`, undefined],
    [`https://${stsHost}/sts/exchange`, "Bearer injected-assertion"],
  ]);

  await assert.rejects(
    exchangeToken(stsHost, { env: {}, getOidc: async () => "", request: async () => leaseIssued }),
    /GitHub OIDC response is invalid/,
  );
});
