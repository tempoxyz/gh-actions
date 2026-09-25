const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  REQUEST_TIMEOUT_MS,
  host,
  isExchangeInProgress,
  rateLimitDelay,
  request,
  requiresFreshAssertion,
  retry,
  retryExchangeInProgress,
  retryRateLimited,
} = require("./http.cjs");
const { ASSERTION_ATTEMPTS, exchangeWithFreshAssertion, exchangeWithRetry, publishToken } = require("./main.cjs");
const { buildRevokeRequest } = require("./post.cjs");
const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("accepts a hostname and rejects URL components", () => {
  assert.equal(host("socket-sts.tempoxyz.net"), "socket-sts.tempoxyz.net");
  assert.equal(host("sts.example.test"), "sts.example.test");
  for (const value of ["", "https://sts.example.test", "sts.example.test:443", "sts.example.test/path"]) {
    assert.throws(() => host(value), /host must be a hostname/);
  }
});

test("retries failed HTTP responses with exponential backoff", async () => {
  let attempts = 0;
  const delays = [];
  const response = await retry(
    async () => {
      attempts += 1;
      return attempts < 3
        ? { status: attempts === 1 ? 401 : 505, body: "upstream failure" }
        : { status: 200, body: "recovered" };
    },
    { random: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(attempts, 3);
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("retries transport failures with exponential backoff", async () => {
  let attempts = 0;
  const delays = [];
  const response = await retry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("connection reset");
      return { status: 200, body: "recovered" };
    },
    { random: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("does not repeat a transport failure that needs a fresh assertion", async () => {
  let attempts = 0;
  const error = new Error("request timed out");
  error.code = "ETIMEDOUT";
  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw error;
      },
      { shouldRetryError: (caught) => caught?.code !== "ETIMEDOUT" },
    ),
    { code: "ETIMEDOUT" },
  );
  assert.equal(attempts, 1);
});

test("times out an unresponsive request after ten seconds", async () => {
  const https = require("node:https");
  const { EventEmitter } = require("node:events");
  const originalRequest = https.request;
  const timeouts = [];
  https.request = () => {
    const call = new EventEmitter();
    call.end = () => {};
    call.destroy = (error) => process.nextTick(() => call.emit("error", error));
    return call;
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay) => {
    timeouts.push(delay);
    process.nextTick(callback);
    return {};
  };

  try {
    await assert.rejects(request("https://example.test"), {
      code: "ETIMEDOUT",
      message: `request timed out after ${REQUEST_TIMEOUT_MS}ms`,
    });
  } finally {
    https.request = originalRequest;
    global.setTimeout = originalSetTimeout;
  }

  assert.deepEqual(timeouts, [REQUEST_TIMEOUT_MS]);
});

test("immediately marks an in-progress exchange for assertion refresh", async () => {
  let attempts = 0;
  await assert.rejects(
    retryExchangeInProgress(async () => {
      attempts += 1;
      return {
        status: 503,
        headers: { "retry-after": "120" },
        body: '{"message":"exchange is already in progress"}',
      };
    }),
    (error) => error.code === "ESTS_FRESH_ASSERTION_REQUIRED",
  );

  assert.equal(attempts, 1);
  assert.equal(
    isExchangeInProgress({
      status: 503,
      body: '{"message":"exchange is already in progress"}',
    }),
    true,
  );
  assert.equal(isExchangeInProgress({ status: 503, body: "{}" }), false);
  assert.equal(
    requiresFreshAssertion({
      status: 502,
      body: '{"message":"Socket API token creation timed out"}',
    }),
    true,
  );
});

test("retries a stuck exchange once with a fresh OIDC assertion", async () => {
  const assertions = [];
  const exchanges = [];
  const result = await exchangeWithFreshAssertion(
    async () => {
      const assertion = `assertion-${assertions.length + 1}`;
      assertions.push(assertion);
      return assertion;
    },
    async (assertion) => {
      exchanges.push(assertion);
      if (exchanges.length === 1) {
        const error = new Error("still in progress");
        error.code = "ESTS_FRESH_ASSERTION_REQUIRED";
        throw error;
      }
      return "token";
    },
  );

  assert.equal(ASSERTION_ATTEMPTS, 2);
  assert.equal(result, "token");
  assert.deepEqual(assertions, ["assertion-1", "assertion-2"]);
  assert.deepEqual(exchanges, ["assertion-1", "assertion-2"]);
});

test("retries a transport timeout once with a fresh OIDC assertion", async () => {
  const assertions = [];
  const result = await exchangeWithFreshAssertion(
    async () => {
      const assertion = `assertion-${assertions.length + 1}`;
      assertions.push(assertion);
      return assertion;
    },
    async () => {
      if (assertions.length === 1) {
        const error = new Error("request timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return "token";
    },
  );

  assert.equal(result, "token");
  assert.deepEqual(assertions, ["assertion-1", "assertion-2"]);
});

test("honors Socket STS rate-limit metadata before retrying", async () => {
  let attempts = 0;
  const delays = [];
  const response = await retryRateLimited(
    async () => {
      attempts += 1;
      return attempts === 1
        ? { status: 429, headers: { "retry-after": "2" }, body: "" }
        : { status: 200, headers: {}, body: "recovered" };
    },
    { now: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(
    rateLimitDelay({ status: 429, headers: {}, body: '{"retry_after_ms":250}' }, 0),
    250,
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

const pendingExchange = {
  status: 429,
  headers: { "retry-after": "1" },
  body: '{"message":"exchange is already in progress"}',
};
const providerRateLimit = {
  status: 429,
  headers: { "retry-after": "1" },
  body: '{"message":"Socket API rate limit exceeded"}',
};
const mintTimeout = {
  status: 502,
  body: '{"message":"Socket API token creation timed out"}',
};

for (const { name, response, fresh } of [
  { name: "provider rate limit", response: providerRateLimit, fresh: true },
  { name: "pending exchange", response: pendingExchange, fresh: false },
  {
    name: "workflow issuance limit",
    response: { ...pendingExchange, body: '{"message":"credential issuance limit reached for this workflow run"}' },
    fresh: false,
  },
  { name: "unknown 429", response: { ...pendingExchange, body: '{}' }, fresh: false },
  { name: "non-JSON 429", response: { ...pendingExchange, body: 'rate limited' }, fresh: false },
]) {
  test(`exchange ${fresh ? "refreshes" : "retains"} the assertion after ${name}`, async () => {
    const events = [];
    const assertions = [];
    let issued = 0;
    const result = await exchangeWithRetry(
      async () => {
        const assertion = `assertion-${++issued}`;
        events.push(assertion);
        return assertion;
      },
      async (assertion) => {
        assertions.push(assertion);
        return assertions.length === 1 ? response : { status: 200, body: "token" };
      },
      { now: () => 0, sleep: async (delay) => events.push(delay) },
    );

    assert.equal(result.body, "token");
    assert.deepEqual(assertions, ["assertion-1", fresh ? "assertion-2" : "assertion-1"]);
    assert.deepEqual(events, fresh ? ["assertion-1", 1_000, "assertion-2"] : ["assertion-1", 1_000]);
  });
}

test("polls the same claim before and after a provider rate limit", async () => {
  const responses = [pendingExchange, providerRateLimit, pendingExchange, { status: 200, body: "token" }];
  const assertions = [];
  const delays = [];
  let issued = 0;
  const result = await exchangeWithRetry(
    async () => `assertion-${++issued}`,
    async (assertion) => {
      assertions.push(assertion);
      return responses.shift();
    },
    { now: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(result.body, "token");
  assert.deepEqual(assertions, ["assertion-1", "assertion-1", "assertion-2", "assertion-2"]);
  assert.deepEqual(delays, [1_000, 1_000, 1_000]);
});

for (const failure of [mintTimeout, Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })]) {
  test(`recovers from a pending exchange followed by ${failure.status || failure.code}`, async () => {
    const responses = [pendingExchange, failure, pendingExchange, { status: 200, body: "token" }];
    const assertions = [];
    let issued = 0;
    const result = await exchangeWithRetry(
      async () => `assertion-${++issued}`,
      async (assertion) => {
        assertions.push(assertion);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
      { now: () => 0, sleep: async () => {} },
    );

    assert.equal(result.body, "token");
    assert.deepEqual(assertions, ["assertion-1", "assertion-1", "assertion-2", "assertion-2"]);
  });
}

test("does not reset the timeout recovery limit after pending polls", async () => {
  const assertions = [];
  let issued = 0;
  await assert.rejects(
    exchangeWithRetry(
      async () => `assertion-${++issued}`,
      async (assertion) => {
        assertions.push(assertion);
        return assertions.length % 2 === 1 ? pendingExchange : mintTimeout;
      },
      { now: () => 0, sleep: async () => {} },
    ),
    { code: "ESTS_FRESH_ASSERTION_REQUIRED" },
  );
  assert.deepEqual(assertions, ["assertion-1", "assertion-1", "assertion-2", "assertion-2"]);
});

for (const response of [pendingExchange, providerRateLimit]) {
  test(`bounds repeated ${JSON.parse(response.body).message} responses to the retry budget`, async () => {
    const assertions = [];
    let issued = 0;
    let now = 0;
    await assert.rejects(
      exchangeWithRetry(
        async () => `assertion-${++issued}`,
        async (assertion) => {
          assertions.push(assertion);
          return { ...response, headers: { "retry-after": "60" } };
        },
        { now: () => now, sleep: async (delay) => { now += delay; } },
      ),
      /exceeds the remaining retry budget/,
    );
    // The first 60s wait fits the 90s budget; the second does not.
    assert.equal(now, 60_000);
    assert.deepEqual(assertions, response === providerRateLimit
      ? ["assertion-1", "assertion-2"]
      : ["assertion-1", "assertion-1"]);
  });
}

test("main fails closed without GitHub id-token permission", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_HOST: "socket-sts.tempoxyz.net",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing/,
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
    publishToken("socket%token-with-sensitive-value", "2026-08-29T03:00:00Z");
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    console.log = originalLog;
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    if (originalState === undefined) delete process.env.GITHUB_STATE;
    else process.env.GITHUB_STATE = originalState;
  }

  assert.deepEqual(calls, [
    ["log", "::add-mask::socket%25token-with-sensitive-value"],
    [
      "append",
      "github-output",
      "token=socket%token-with-sensitive-value\n",
    ],
    ["append", "github-output", "expires-at=2026-08-29T03:00:00Z\n"],
    [
      "append",
      "github-state",
      "token=socket%token-with-sensitive-value\n",
    ],
    ["append", "github-output", `node-path=${process.execPath}\n`],
  ]);
});

test("revokes tokens by deleting the exchange resource", () => {
  const token = "sktsec_test_short_lived_token_api";
  const revoke = buildRevokeRequest(token, "socket-sts.tempoxyz.dev");

  assert.equal(revoke.url, "https://socket-sts.tempoxyz.dev/sts/exchange");
  assert.equal(revoke.options.method, "DELETE");
  assert.equal(revoke.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(revoke.body), { token });
});

test("can register a post-job Aegis audit-log upload", async () => {
  assert.match(
    manifest,
    /upload-aegis-report:\r?\n    description: "Upload the final Aegis audit log as a job artifact"\r?\n    required: false\r?\n    default: "true"/,
  );
  assert.match(manifest, /runs:\r?\n  using: "node24"\r?\n  main: "main\.cjs"\r?\n  post: "post\.cjs"/);
  const { aegisReportPath, artifactName } = require("./dist/artifact-upload.cjs");
  assert.equal(aegisReportPath("linux"), "/var/log/aegis/service.jsonl");
  assert.equal(aegisReportPath("darwin"), "/Library/Application Support/Aegis/service.jsonl");
  assert.equal(
    aegisReportPath("win32", { ProgramData: "C:\\ProgramData" }),
    "C:\\ProgramData\\Aegis\\service.jsonl",
  );
  assert.equal(
    artifactName("socket-sts 2", { GITHUB_JOB: "lint / check" }),
    "aegis-service-log-lint---check-socket-sts-2",
  );
  assert.match(fs.readFileSync(path.join(__dirname, "post.cjs"), "utf8"), /STATE_upload_aegis_report/);
});

test("post is a no-op when no token was minted", () => {
  const withoutNode = fs.mkdtempSync(path.join(os.tmpdir(), "socket-sts-no-node-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: withoutNode, STATE_token: "" },
    });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /skipping revocation/);
  } finally {
    fs.rmSync(withoutNode, { force: true, recursive: true });
  }
});

const { JITTER_RATIO, RETRY_BUDGET_MS } = require("./http.cjs");

test("backoff carries up to 25% jitter", async () => {
  assert.equal(JITTER_RATIO, 0.25);
  const delays = [];
  let attempts = 0;
  const response = await retry(
    async () => ({ status: ++attempts < 3 ? 503 : 200, body: "" }),
    { random: () => 1, sleep: async (delay) => delays.push(delay) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [1250, 2500]);
});

test("one 90-second budget bounds the exchange and shrinks request timeouts to what is left", async () => {
  assert.equal(RETRY_BUDGET_MS, 90_000);
  const timeouts = [];
  const result = await exchangeWithRetry(
    async () => "assertion-1",
    async (_assertion, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: 200, body: "token" };
    },
    { now: () => 0, deadline: 4_000, sleep: async () => {} },
  );
  assert.equal(result.body, "token");
  assert.deepEqual(timeouts, [4_000]);

  // Transient retries stop at the deadline and hand back the last response,
  // with each request's timeout shrunk to the remaining budget.
  let clock = 0;
  const bounded = [];
  const last = await exchangeWithRetry(
    async () => "assertion-1",
    async (_assertion, timeoutMs) => {
      bounded.push(timeoutMs);
      clock += 10_000;
      return { status: 503, body: "" };
    },
    {
      now: () => clock,
      deadline: 15_000,
      random: () => 0,
      sleep: async (delay) => {
        clock += delay;
      },
    },
  );
  assert.equal(last.status, 503, "the caller reports the final status");
  assert.deepEqual(bounded, [10_000, 4_000]);
  assert.equal(clock, 21_000);
});

const { main: postMain } = require("./post.cjs");

function captureLog(callback) {
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

test("post reports a failed token revocation as a warning and still uploads the audit log", async () => {
  const state = {
    STATE_token: "sktsec_test_short_lived_token_api",
    STATE_host: "socket-sts.tempoxyz.net",
    STATE_upload_aegis_report: "true",
  };
  const cases = [
    {
      name: "5xx after retries",
      request: async () => ({ status: 503, headers: {}, body: "" }),
      expected: /^::warning title=Socket STS token revocation failed::The Socket STS answered HTTP 503 when revoking the token\. The STS lease expiration still bounds the token's lifetime\.$/,
      attempts: 4,
    },
    {
      name: "transport failure after retries",
      request: async () => {
        throw new Error("connection reset");
      },
      expected: /^::warning title=Socket STS token revocation failed::Could not reach the Socket STS to revoke the token: connection reset\. The STS lease expiration still bounds the token's lifetime\.$/,
      attempts: 4,
    },
  ];
  for (const { name, request, expected, attempts } of cases) {
    let calls = 0;
    let uploads = 0;
    const { lines } = await captureLog(() =>
      postMain({
        env: state,
        request: async (...args) => {
          calls += 1;
          return request(...args);
        },
        upload: async () => {
          uploads += 1;
        },
        sleep: async () => {},
      }),
    );
    assert.equal(calls, attempts, name);
    assert.equal(uploads, 1, `${name}: the audit log still uploads`);
    const warnings = lines.filter((line) => line.startsWith("::warning"));
    assert.equal(warnings.length, 1, `${name}: ${lines.join("\n")}`);
    assert.match(warnings[0], expected, name);
  }

  const ok = await captureLog(() =>
    postMain({
      env: { ...state, STATE_upload_aegis_report: "false" },
      request: async () => ({ status: 204, headers: {}, body: "" }),
      upload: async () => assert.fail("upload disabled"),
    }),
  );
  assert.deepEqual(ok.lines, ["Socket API token revoked."]);

  await assert.rejects(
    postMain({ env: { ...state, STATE_token: "short" }, request: async () => assert.fail("no request") }),
    /stored Socket token is invalid/,
  );
});
