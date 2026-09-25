const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { MAX_TTL_MS, parseTtl } = require("./ttl.cjs");

test("accepts friendly TTL values up to one hour", () => {
  assert.equal(parseTtl("45s"), 45 * 1000);
  assert.equal(parseTtl("5m"), 5 * 60 * 1000);
  assert.equal(parseTtl("1h"), MAX_TTL_MS);
  assert.equal(parseTtl("60m"), MAX_TTL_MS);
  assert.equal(parseTtl("3600s"), MAX_TTL_MS);
});

test("rejects malformed, zero, and over-one-hour TTL values", () => {
  for (const value of [
    "",
    "0s",
    "1",
    "1d",
    "1.5m",
    "1m30s",
    "60M",
    "61m",
    "3601s",
  ]) {
    assert.throws(() => parseTtl(value), /ttl/);
  }
});

function run(inputs = {}, script = "main.cjs") {
  return spawnSync(process.execPath, [path.join(__dirname, script)], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_ACCOUNT: "prd",
      INPUT_HOST: "",
      INPUT_POLICY: "e2e",
      INPUT_TTL: "15m",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      ...inputs,
    },
  });
}

test("entrypoint fails closed without GitHub id-token permission", () => {
  const result = run();
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /id-token: write permission is required/);
});

test("entrypoint rejects a TTL longer than one hour before requesting OIDC", () => {
  const result = run({ INPUT_TTL: "61m" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /ttl must not exceed 1h/);
  assert.doesNotMatch(output, /id-token: write permission is required/);
});

test("entrypoint rejects unknown accounts before requesting OIDC", () => {
  const result = run({ INPUT_ACCOUNT: "production" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /account must be dev, prd, or infra/);
  assert.doesNotMatch(output, /id-token: write permission is required/);
});

test("rejects invalid hostnames before requesting OIDC", () => {
  const { validateHost } = require("./host.cjs");
  for (const host of [
    "",
    "https://sts.example",
    "sts.example/path",
    "sts.example:443",
    "user@sts.example",
    "sts.example?query",
    "sts.example#fragment",
    "-sts.example",
    "sts..example",
    "a".repeat(64) + ".example",
    "a.".repeat(127),
  ]) {
    assert.throws(() => validateHost(host), /host must be a hostname/);
  }
  const result = run({ INPUT_HOST: "https://sts.example" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host must be a hostname/);
});

test("post entrypoint skips cleanup when no token was minted", () => {
  const result = run({}, "post.cjs");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /No Cloudflare API token was minted; skipping deletion/);
});

test("post entrypoint requires id-token permission for cleanup", () => {
  const result = run(
    {
      STATE_token_id: "0123456789abcdef0123456789abcdef",
      STATE_account: "prd",
      STATE_identity: "e2e",
      STATE_host: "cf-sts.tempoxyz.net",
    },
    "post.cjs",
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing/);
  assert.doesNotMatch(output, /retrying/);
});

for (const rateLimited of [false, true]) {
  for (const script of ["main.cjs", "post.cjs"]) {
    for (const inputHost of ["", "sts.dev.example.com", "sts.example.com"]) {
      const host = inputHost || "cf-sts.tempoxyz.net";
      test(`${script} uses the ${inputHost || "default"} host for OIDC and STS${rateLimited ? " after a 429" : ""}`, async () => {
        const fs = require("node:fs");
        const vm = require("node:vm");
        const { EventEmitter } = require("node:events");
        const calls = [];
        const writes = [];
        const delays = [];
        const fakeProcess = {
          env: {
            INPUT_ACCOUNT: "dev",
            INPUT_HOST: inputHost,
            INPUT_POLICY: "e2e",
            INPUT_TTL: "15m",
            STATE_token_id: "a".repeat(32),
            STATE_account: "dev",
            STATE_identity: "e2e",
            STATE_host: host,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
          },
        };
        const fakeModule = { exports: {} };
        const fakeRequire = (name) => {
          if (name === "node:fs")
            return {
              appendFileSync(file, value) {
                writes.push(value);
              },
            };
          if (name === "./retry.cjs") {
            const actual = require(name);
            return {
              ...actual,
              retry: (op, options) =>
                actual.retry(op, {
                  ...options,
                  now: () => 0,
                  sleep: async (ms) => delays.push(ms),
                }),
            };
          }
          if (name === "./http.cjs") {
            const httpModule = { exports: {} };
            vm.runInNewContext(
              fs.readFileSync(path.join(__dirname, "http.cjs"), "utf8"),
              {
                require: fakeRequire,
                module: httpModule,
                Buffer,
                setTimeout,
                clearTimeout,
              },
            );
            return httpModule.exports;
          }
          if (name !== "node:https") return require(name);
          return {
            request(url, options, callback) {
              calls.push({ url, options });
              const outbound = new EventEmitter();
              outbound.end = () =>
                queueMicrotask(() => {
                  const response = new EventEmitter();
                  response.setEncoding = () => {};
                  response.statusCode =
                    rateLimited && calls.length === 2
                      ? 429
                      : options.method === "DELETE"
                        ? 204
                        : 200;
                  response.headers =
                    response.statusCode === 429 ? { "retry-after": "30" } : {};
                  callback(response);
                  response.emit(
                    "data",
                    JSON.stringify(
                      calls.length === 1
                        ? { value: "signed-oidc-token" }
                        : {
                            token: "cloudflare-token",
                            token_id: "a".repeat(32),
                            account_id: "b".repeat(32),
                            expires_at: "2026-09-21T12:00:00Z",
                          },
                    ),
                  );
                  response.emit("end");
                });
              return outbound;
            },
          };
        };
        fakeRequire.main = fakeModule;
        vm.runInNewContext(
          fs.readFileSync(path.join(__dirname, script), "utf8"),
          {
            require: fakeRequire,
            module: fakeModule,
            process: fakeProcess,
            URL,
            Buffer,
            console: { log() {}, error() {} },
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(fakeProcess.exitCode, undefined);
        assert.equal(calls.length, rateLimited ? 3 : 2);
        assert.deepEqual(delays, rateLimited ? [30_000] : []);
        if (rateLimited) {
          assert.equal(
            calls[1].options.headers.Authorization,
            "Bearer signed-oidc-token",
          );
          assert.equal(
            calls[2].options.headers.Authorization,
            calls[1].options.headers.Authorization,
          );
        }
        if (script === "main.cjs") assert.ok(writes.includes(`host=${host}\n`));
        assert.equal(calls[0].url.searchParams.get("audience"), host);
        assert.equal(calls[1].url.origin, `https://${host}`);
        assert.equal(calls[1].url.pathname, "/sts/exchange");
        assert.equal(
          calls[1].options.method,
          script === "main.cjs" ? "POST" : "DELETE",
        );
      });
    }
  }
}
