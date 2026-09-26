const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const test = require("node:test");
const {
  REQUEST_TIMEOUT_MS,
  buildExchangeUrl,
  exchangeRequestOptions,
  exchangeWithRetry,
  main,
  request,
  retryTimeoutMs,
} = require("./main.js");
const {
  revocationRequestOptions,
  revokeToken,
  stsRevocationRequestOptions,
} = require("./post.js");
const { host } = require("./host.js");

const actionDirectory = __dirname;

test("validates the total retry budget", () => {
  assert.equal(retryTimeoutMs(), 90_000);
  assert.equal(retryTimeoutMs("3600"), 3_600_000);
  for (const value of ["0", "-1", "1.5", "Infinity", "3601", "abc", "1e2"]) {
    assert.throws(() => retryTimeoutMs(value), /retry-timeout must be/);
  }
});

test("request retains response headers for retry scheduling", async (t) => {
  t.mock.method(https, "request", (_url, _options, callback) => {
    const response = new EventEmitter();
    response.statusCode = 429;
    response.headers = { "retry-after": "3600" };
    response.setEncoding = () => {};
    const call = new EventEmitter();
    call.end = () => {
      callback(response);
      response.emit("data", "{}");
      response.emit("end");
    };
    return call;
  });
  const response = await request("https://sts.example.test");
  assert.equal(response.headers["retry-after"], "3600");
});

test("refreshes OIDC only after a confirmed rate-limit wait", async () => {
  let clock = 0;
  let assertions = 0;
  const calls = [];
  const result = await exchangeWithRetry("https://sts.example.test", async () => {
    calls.push(["oidc", clock]);
    return `assertion-${++assertions}`;
  }, async (_url, options) => {
    calls.push([options.headers.Authorization, clock]);
    return assertions === 1 ? { status: 429 } : { status: 200 };
  }, {
    isTransient: (r) => r.status === 429,
    getDelayMs: () => 600_000,
    now: () => clock, deadlineMs: 700_000,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [
    ["oidc", 0], ["Bearer assertion-1", 0],
    ["oidc", 600_000], ["Bearer assertion-2", 600_000],
  ]);
});

test("reuses OIDC after ambiguous transport and server errors", async () => {
  let assertions = 0;
  const tokens = [];
  const result = await exchangeWithRetry("https://sts.example.test", async () => `assertion-${++assertions}`,
    async (_url, options) => {
      tokens.push(options.headers.Authorization);
      if (tokens.length === 1) throw new Error("connection lost after mint");
      return { status: tokens.length === 2 ? 503 : 200 };
    }, { isTransient: (r) => r.status === 503, sleep: async () => {} });
  assert.equal(result.status, 200);
  assert.equal(assertions, 1);
  assert.deepEqual(tokens, Array(3).fill("Bearer assertion-1"));
});

test("accepts a hostname and rejects URL components", () => {
  assert.equal(host("gh-sts.tempoxyz.net"), "gh-sts.tempoxyz.net");
  assert.equal(host("sts.example.test"), "sts.example.test");
  for (const value of ["", "https://sts.example.test", "sts.example.test:443", "sts.example.test/path"]) {
    assert.throws(() => host(value), /host must be a hostname/);
  }
});

test("exchange request forwards ttl only when specified", () => {
  const withTtl = buildExchangeUrl("gh-sts.tempoxyz.net", "tempoxyz/example", "deploy", "30s");
  assert.equal(withTtl.searchParams.get("scope"), "tempoxyz/example");
  assert.equal(withTtl.searchParams.get("identity"), "deploy");
  assert.equal(withTtl.searchParams.get("ttl"), "30s");

  const defaultTtl = buildExchangeUrl("gh-sts.tempoxyz.net", "tempoxyz/example", "deploy", "");
  assert.equal(defaultTtl.searchParams.has("ttl"), false);
});

test("exchange request uses POST with the OIDC bearer token", () => {
  const options = exchangeRequestOptions("test-oidc");

  assert.equal(options.method, "POST");
  assert.equal(options.headers.Accept, "application/json");
  assert.equal(options.headers.Authorization, "Bearer test-oidc");
  assert.equal(options.headers["User-Agent"], "tempoxyz-gh-actions-github-sts");
});

test("times out a stalled request so the retry wrapper can recover", async (t) => {
  const timeouts = [];
  t.mock.method(https, "request", () => {
    const call = new EventEmitter();
    call.end = () => {};
    call.destroy = (error) => process.nextTick(() => call.emit("error", error));
    return call;
  });
  t.mock.method(global, "setTimeout", (callback, delay) => {
    timeouts.push(delay);
    process.nextTick(callback);
    return {};
  });

  await assert.rejects(request("https://example.test"), {
    code: "ETIMEDOUT",
    message: `request timed out after ${REQUEST_TIMEOUT_MS}ms`,
  });
  assert.deepEqual(timeouts, [REQUEST_TIMEOUT_MS]);
});

test("main entrypoint executes as CommonJS", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY_OWNER: "tempoxyz",
      INPUT_HOST: "gh-sts.tempoxyz.net",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /id-token: write permission is required/);
  assert.doesNotMatch(output, /ERR_AMBIGUOUS_MODULE_SYNTAX/);
});

for (const owner of ["paradigmxyz", "newly-onboarded-org", ""]) {
  test(`main validates STS inputs without checking owner ${owner || "<unset>"}`, () => {
    const result = spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY_OWNER: owner,
        INPUT_HOST: "https://invalid.example",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /host must be a hostname without a scheme, port, or path/);
    assert.doesNotMatch(output, /only supports repositories owned/);
  });
}

for (const status of [200, 403, 429]) {
  test(`main delegates a new organization's authorization to STS (HTTP ${status})`, async (t) => {
    const env = {
      GITHUB_REPOSITORY_OWNER: "newly-onboarded-org",
      GITHUB_REPOSITORY: "newly-onboarded-org/example",
      INPUT_HOST: "gh-sts.tempoxyz.net",
      INPUT_SCOPE: "tempoxyz/aegis",
      INPUT_POLICY: "download-releases",
      INPUT_TTL: "15m",
      INPUT_RETRY_TIMEOUT: "90",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      GITHUB_OUTPUT: "test-output",
      GITHUB_STATE: "test-state",
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const calls = [];
    t.mock.method(https, "request", (url, options, callback) => {
      calls.push({ url: new URL(url), options });
      const oidc = calls.length === 1;
      const response = new EventEmitter();
      response.statusCode = oidc ? 200 : status;
      response.headers = status === 429 && !oidc ? { "retry-after": "3600" } : {};
      response.setEncoding = () => {};
      const request = new EventEmitter();
      request.end = () => {
        callback(response);
        response.emit("data", JSON.stringify(oidc ? { value: "test-oidc" } : status === 200
          ? { token: "test-installation-token", expires_at: "2030-01-01T00:00:00Z" }
          : { message: "caller organization is not permitted by this service" }));
        response.emit("end");
      };
      return request;
    });
    const writes = t.mock.method(fs, "appendFileSync", () => {});
    const logs = t.mock.method(console, "log", () => {});

    if (status === 200) {
      await main();
      assert.deepEqual(writes.mock.calls.map(({ arguments: args }) => args), [
        ["test-output", "token=test-installation-token\n"],
        ["test-output", "expires-at=2030-01-01T00:00:00Z\n"],
        ["test-state", "token=test-installation-token\nsts_host=gh-sts.tempoxyz.net\n"],
      ]);
      assert.deepEqual(logs.mock.calls.map(({ arguments: args }) => args), [
        ["::add-mask::test-installation-token"],
      ]);
    } else if (status === 429) {
      await assert.rejects(main(), /retry timeout exceeded; next retry permitted at/);
      assert.equal(writes.mock.callCount(), 0);
      assert.equal(logs.mock.callCount(), 0);
    } else {
      await assert.rejects(main(), /GitHub STS exchange failed \(HTTP 403\): caller organization is not permitted by this service/);
      assert.equal(writes.mock.callCount(), 0);
      assert.equal(logs.mock.callCount(), 0);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get("audience"), "gh-sts.tempoxyz.net");
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-request-token");
    assert.equal(calls[1].url.href, "https://gh-sts.tempoxyz.net/sts/exchange?scope=tempoxyz%2Faegis&identity=download-releases&ttl=15m");
    assert.equal(calls[1].options.method, "POST");
    assert.equal(calls[1].options.headers.Authorization, "Bearer test-oidc");
  });
}

test("post entrypoint executes as CommonJS without a token", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "post.js")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No GitHub App token was minted; skipping revocation/);
  assert.doesNotMatch(output, /ERR_AMBIGUOUS_MODULE_SYNTAX/);
});

test("revocation request identifies the action to GitHub", () => {
  const options = revocationRequestOptions("test-token");

  assert.equal(options.headers["User-Agent"], "tempoxyz-gh-actions-github-sts");
});

test("STS revocation request authenticates with the minted token", () => {
  const options = stsRevocationRequestOptions("test-token");

  assert.equal(options.method, "DELETE");
  assert.equal(options.headers.Authorization, "Bearer test-token");
  assert.equal(options.headers["User-Agent"], "tempoxyz-gh-actions-github-sts");
});

test("workflow cleanup revokes through STS without calling GitHub directly", async () => {
  const calls = [];
  const messages = [];
  await revokeToken("test-token", "gh-sts.tempoxyz.dev", {
    request: async (url, options) => {
      calls.push({ url, options });
      return 204;
    },
    retry: async (operation) => operation(),
    console: { log: (message) => messages.push(message), warn: (message) => messages.push(message) },
  });

  assert.deepEqual(calls.map((call) => call.url), ["https://gh-sts.tempoxyz.dev/sts/exchange"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(messages, ["GitHub App token revoked and STS ledger updated."]);
});

test("workflow cleanup falls back to GitHub and then reconciles the STS ledger", async () => {
  const calls = [];
  const statuses = [404, 204, 204];
  await revokeToken("test-token", "gh-sts.tempoxyz.net", {
    request: async (url) => {
      calls.push(url);
      return statuses.shift();
    },
    retry: async (operation) => operation(),
    console: { log() {}, warn() {} },
  });

  assert.deepEqual(calls, [
    "https://gh-sts.tempoxyz.net/sts/exchange",
    "https://api.github.com/installation/token",
    "https://gh-sts.tempoxyz.net/sts/exchange",
  ]);
});

test("workflow cleanup does not send a token to a malformed STS host", async () => {
  const calls = [];
  await revokeToken("test-token", "https://attacker.example", {
    request: async (url) => {
      calls.push(url);
      return 204;
    },
    retry: async (operation) => operation(),
    console: { log() {}, warn() {} },
  });

  assert.deepEqual(calls, ["https://api.github.com/installation/token"]);
});

test("post reports a revocation that both STS and GitHub refuse as a warning", async () => {
  const { main: postMain } = require("./post.js");
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let requests = 0;
  try {
    await postMain({
      env: { STATE_token: "test-token", STATE_sts_host: "gh-sts.tempoxyz.net" },
      dependencies: {
        request: async () => {
          requests += 1;
          return 500;
        },
        retry: async (operation) => operation(),
        console: { log: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) },
      },
    });
  } finally {
    console.log = original;
  }
  assert.ok(requests >= 2, "STS and then GitHub were both attempted");
  const warnings = lines.filter((line) => line.startsWith("::warning"));
  assert.deepEqual(warnings, [
    "::warning title=GitHub App token revocation failed::Failed to revoke GitHub App token (HTTP 500). The token expires at its requested TTL.",
  ]);
});

test("exchange mints a token under the requested policy and reports failures by status", async () => {
  const { exchange } = require("./main.js");
  const calls = [];
  const result = await exchange({
    host: "gh-sts.tempoxyz.net",
    scope: "tempoxyz/aegis",
    policy: "download-releases",
    ttl: "15m",
    getOidc: async () => "assertion-1",
    request: async (url, options, timeoutMs) => {
      calls.push([String(url), options.headers.Authorization, timeoutMs]);
      return { status: 200, body: JSON.stringify({ token: "ghs_test_token", expires_at: "2026-09-26T00:15:00Z" }), headers: {} };
    },
    now: () => 0,
  });
  assert.deepEqual(result, { token: "ghs_test_token", expiresAt: "2026-09-26T00:15:00Z" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0][0]);
  assert.equal(url.host, "gh-sts.tempoxyz.net");
  assert.equal(url.searchParams.get("scope"), "tempoxyz/aegis");
  assert.equal(url.searchParams.get("identity"), "download-releases");
  assert.equal(url.searchParams.get("ttl"), "15m");
  assert.equal(calls[0][1], "Bearer assertion-1");
  assert.equal(calls[0][2], 10_000);

  await assert.rejects(
    exchange({
      host: "gh-sts.tempoxyz.net",
      scope: "tempoxyz/aegis",
      policy: "download-releases",
      getOidc: async () => "assertion-1",
      request: async () => ({ status: 403, body: '{"message":"trust policy: subject did not match"}', headers: {} }),
      now: () => 0,
    }),
    { message: "GitHub STS exchange failed (HTTP 403): trust policy: subject did not match" },
  );
});
