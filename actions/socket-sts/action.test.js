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
const { ASSERTION_ATTEMPTS, exchangeWithFreshAssertion, publishToken } = require("./main.cjs");
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
    { sleep: async (delay) => delays.push(delay) },
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
    { sleep: async (delay) => delays.push(delay) },
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

test("fails instead of waiting more than two minutes for a Socket STS rate limit", async () => {
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
