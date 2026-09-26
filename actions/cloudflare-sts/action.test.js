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

// Runs an entrypoint script inside a VM with a scripted HTTPS layer: the
// status probe (main only), then the OIDC issuer, then the STS. `probe` is the
// status body the STS answers with.
async function runScript(script, { inputHost, rateLimited = false, probe = { status: "enabled" } }) {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { EventEmitter } = require("node:events");
  const host = inputHost || "cf-sts.tempoxyz.net";
  const probes = script === "main.cjs" ? 1 : 0;
  const calls = [];
  const writes = [];
  const delays = [];
  const logs = [];
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
  const inVm = (filename, extra = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, filename), "utf8"), {
      require: fakeRequire,
      module,
      process: fakeProcess,
      Buffer,
      setTimeout,
      clearTimeout,
      console: { log: (line) => logs.push(String(line)), error() {} },
      ...extra,
    });
    return module.exports;
  };
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
    if (name === "./http.cjs" || name === "./status.cjs") return inVm(name);
    if (name !== "node:https") return require(name);
    return {
      request(url, options, callback) {
        calls.push({ url: new URL(String(url)), options });
        const index = calls.length;
        const outbound = new EventEmitter();
        outbound.end = () =>
          queueMicrotask(() => {
            const response = new EventEmitter();
            response.setEncoding = () => {};
            response.statusCode =
              rateLimited && index === probes + 2
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
                index <= probes
                  ? probe
                  : index === probes + 1
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
      console: { log: (line) => logs.push(String(line)), error() {} },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return { host, probes, calls, writes, delays, logs, fakeProcess };
}

for (const rateLimited of [false, true]) {
  for (const script of ["main.cjs", "post.cjs"]) {
    for (const inputHost of ["", "sts.dev.example.com", "sts.example.com"]) {
      test(`${script} uses the ${inputHost || "default"} host for OIDC and STS${rateLimited ? " after a 429" : ""}`, async () => {
        const { host, probes, calls, writes, delays, fakeProcess } = await runScript(script, { inputHost, rateLimited });
        assert.equal(fakeProcess.exitCode, undefined);
        assert.equal(calls.length, probes + (rateLimited ? 3 : 2));
        assert.deepEqual(delays, rateLimited ? [30_000] : []);
        if (rateLimited) {
          assert.equal(
            calls[probes + 1].options.headers.Authorization,
            "Bearer signed-oidc-token",
          );
          assert.equal(
            calls[probes + 2].options.headers.Authorization,
            calls[probes + 1].options.headers.Authorization,
          );
        }
        if (script === "main.cjs") {
          assert.ok(writes.includes(`host=${host}\n`));
          // The status probe comes first: one empty POST with no assertion.
          assert.equal(calls[0].url.href, `https://${host}/status`);
          assert.equal(calls[0].options.method, "POST");
          assert.equal(calls[0].options.headers["content-length"], "0");
          assert.equal(calls[0].options.headers.Authorization, undefined);
        }
        assert.equal(calls[probes].url.searchParams.get("audience"), host);
        assert.equal(calls[probes + 1].url.origin, `https://${host}`);
        assert.equal(calls[probes + 1].url.pathname, "/sts/exchange");
        assert.equal(
          calls[probes + 1].options.method,
          script === "main.cjs" ? "POST" : "DELETE",
        );
      });
    }
  }
}

test("main reports a paused Cloudflare STS as disabled with its reason and requests nothing else", async () => {
  const { calls, writes, logs, fakeProcess } = await runScript("main.cjs", {
    inputHost: "",
    probe: { status: "disabled", reason: "Paused" },
  });
  assert.equal(fakeProcess.exitCode, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://cf-sts.tempoxyz.net/status");
  assert.deepEqual(writes, []);
  assert.deepEqual(logs, [
    "::warning title=Cloudflare STS disabled::The Cloudflare STS is disabled: Paused. No Cloudflare API token was issued to this job.",
  ]);
});

test("an inconclusive Cloudflare STS status probe never blocks the exchange", async () => {
  for (const probe of [{ status: "draining" }, "not an object", null]) {
    const { calls, fakeProcess, logs } = await runScript("main.cjs", { inputHost: "", probe });
    assert.equal(fakeProcess.exitCode, undefined, JSON.stringify(probe));
    assert.equal(calls.length, 3, JSON.stringify(probe));
    const notes = logs.filter((line) => !line.startsWith("::add-mask::"));
    assert.equal(notes.length, 1, JSON.stringify(probe));
    assert.match(notes[0], /^Cloudflare STS status check was inconclusive \(unrecognized response\); continuing with the exchange\.$/);
  }
});
