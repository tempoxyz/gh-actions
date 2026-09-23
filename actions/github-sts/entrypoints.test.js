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
  main,
  request,
} = require("./main.js");
const {
  revocationRequestOptions,
  revokeToken,
  stsRevocationRequestOptions,
} = require("./post.js");
const { host } = require("./host.js");

const actionDirectory = __dirname;

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

for (const status of [200, 403]) {
  test(`main delegates a new organization's authorization to STS (HTTP ${status})`, async (t) => {
    const env = {
      GITHUB_REPOSITORY_OWNER: "newly-onboarded-org",
      GITHUB_REPOSITORY: "newly-onboarded-org/example",
      INPUT_HOST: "gh-sts.tempoxyz.net",
      INPUT_SCOPE: "tempoxyz/aegis",
      INPUT_POLICY: "download-releases",
      INPUT_TTL: "15m",
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
