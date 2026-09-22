const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const { AUDIENCE, LEGACY_AUDIENCE, TIMEOUT_MS, runnerOIDCEnvironment, createGitHubOIDC } = require("./github-oidc.cjs");
const { createTokenServer } = require("./token-server.cjs");
const { startProvider, childEnvironment } = require("./token-provider.cjs");

const SOCKET_TOKEN = "socket-fixture-" + "a".repeat(32);
const SOURCE = { requestURL: "https://runner.example/oidc?existing=keep&audience=old", requestToken: "request-fixture-secret" };
const jwt = (expires, aud = AUDIENCE) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), aud })).toString("base64url")}.c2ln`;
const result = (value) => Response.json({ value });

test("acquires the fixed audience, caches concurrent requests and refreshes before expiry", async () => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let failed = false;
  const get = createGitHubOIDC(SOURCE, {
    now: () => now,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url.protocol, "https:");
      assert.equal(url.searchParams.get("existing"), "keep");
      assert.deepEqual(url.searchParams.getAll("audience"), [AUDIENCE]);
      assert.equal(options.method, "GET");
      assert.deepEqual(options.headers, { Authorization: `Bearer ${SOURCE.requestToken}`, Accept: "application/json" });
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (failed) return new Response("denied", { status: 403 });
      return result(jwt(now + 300_000));
    },
  });
  let expected = jwt(now + 300_000);
  assert.deepEqual(await Promise.all(Array.from({ length: 25 }, () => get(AUDIENCE))), Array(25).fill(expected));
  assert.equal(calls, 1);
  now += 275_000;
  expected = jwt(now + 300_000);
  assert.equal(await get(AUDIENCE), expected);
  assert.equal(calls, 2);
  now += 275_000;
  failed = true;
  assert.equal(await get(AUDIENCE), expected, "retain still-valid token on refresh failure");
  assert.equal(calls, 3);
  now += 26_000;
  assert.equal(await get(AUDIENCE), "", "never serve an expired token");
  assert.equal(calls, 3, "throttle failed acquisition");
  now += 35_000;
  failed = false;
  assert.notEqual(await get(AUDIENCE), "");
  assert.equal(calls, 4);
});

test("supports the legacy audience with an independent cache during migration", async () => {
  const calls = [];
  const get = createGitHubOIDC(SOURCE, {
    fetcher: async (url) => {
      const audience = url.searchParams.get("audience");
      calls.push(audience);
      return result(jwt(Date.now() + 300_000, audience));
    },
  });
  assert.notEqual(await get(AUDIENCE), "");
  assert.notEqual(await get(LEGACY_AUDIENCE), "");
  assert.notEqual(await get(AUDIENCE), "");
  assert.notEqual(await get(LEGACY_AUDIENCE), "");
  assert.deepEqual(calls, [AUDIENCE, LEGACY_AUDIENCE]);
});

test("ignores absent or unsupported audience requests and unsafe sources", async () => {
  let calls = 0;
  const unexpected = async () => { calls++; return result(""); };
  const get = createGitHubOIDC(SOURCE, { fetcher: unexpected });
  for (const audience of [undefined, "", "https://other.example", [AUDIENCE]]) assert.equal(await get(audience), "");
  for (const source of [{}, { requestURL: SOURCE.requestURL }, { requestToken: SOURCE.requestToken },
    { ...SOURCE, requestURL: "http://runner.example" }, { ...SOURCE, requestURL: "https://user:pass@runner.example" },
    { ...SOURCE, requestURL: "https://runner.example#fragment" }, { ...SOURCE, requestToken: "bad\nsecret" }]) {
    assert.equal(await createGitHubOIDC(source, { fetcher: unexpected })(AUDIENCE), "");
  }
  assert.equal(calls, 0, "invalid source or audience triggered a network request");
});

test("omits denied, malformed, oversized, expired and wrong-audience responses without throwing", async () => {
  const future = Date.now() + 300_000;
  for (const [name, reply] of [
    ["denied", () => new Response("private response", { status: 403 })],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://other.example" } })],
    ["network", () => { throw new Error("private endpoint and request credential"); }],
    ["invalid JSON", () => new Response("{")],
    ["empty", () => Response.json({})],
    ["invalid JWT", () => result("invalid")],
    ["missing expiry", () => result("e30.e30.c2ln")],
    ["expired", () => result(jwt(Date.now() - 1000))],
    ["wrong audience", () => result(jwt(future, "other"))],
    ["malformed audience", () => result(jwt(future, [AUDIENCE, 1]))],
    ["oversized JWT", () => result("a".repeat(16_385))],
    ["oversized body", () => new Response("x".repeat(65_537))],
  ]) {
    let calls = 0;
    const get = createGitHubOIDC(SOURCE, { fetcher: async () => { calls++; return reply(); } });
    assert.equal(await get(AUDIENCE), "", name);
    assert.equal(await get(AUDIENCE), "", name);
    assert.equal(calls, 1, name);
  }
});

test("aborts a stalled response body within the acquisition deadline", async () => {
  let aborted = false;
  const get = createGitHubOIDC(SOURCE, {
    fetcher: async (_url, { signal }) => ({
      status: 200,
      body: new ReadableStream({ start(controller) {
        signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
      } }),
    }),
  });
  assert.ok(TIMEOUT_MS < 2000);
  assert.equal(await get(AUDIENCE), "");
  assert.equal(aborted, true);
});

test("handoff only selects the two OIDC values and keeps child environment sanitized", () => {
  assert.deepEqual(runnerOIDCEnvironment({ ACTIONS_ID_TOKEN_REQUEST_URL: SOURCE.requestURL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SOURCE.requestToken, UNRELATED_SECRET: "excluded" }), SOURCE);
  assert.deepEqual(runnerOIDCEnvironment({}), { requestURL: "", requestToken: "" });
  assert.doesNotMatch(JSON.stringify(childEnvironment()), /TOKEN|SECRET|PROXY|NODE_OPTIONS/i);
});

test("real loopback HTTP protocol preserves legacy credentials and serves optional raw JWTs", async () => {
  let calls = 0;
  const expected = jwt(Date.now() + 300_000);
  const get = createGitHubOIDC(SOURCE, { fetcher: async () => { calls++; return result(expected); } });
  const { server, route } = createTokenServer(SOCKET_TOKEN, get);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}${route}`;
  try {
    for (const body of [undefined, "{}", JSON.stringify({ github_oidc_audience: "other" })]) {
      const response = await fetch(url, { method: "POST", body });
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.deepEqual(await response.json(), { token: SOCKET_TOKEN });
    }
    assert.equal(calls, 0);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url, { method: "POST", body: JSON.stringify({ github_oidc_audience: AUDIENCE }) });
      assert.deepEqual(await response.json(), { token: SOCKET_TOKEN, github_oidc_jwt: expected });
    }
    assert.equal(calls, 1);
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(new URL("/wrong", url), { method: "POST" })).status, 404);
    const malformed = await fetch(url, { method: "POST", body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal(await malformed.text(), "");
    await assert.rejects(fetch(url, { method: "POST", body: "x".repeat(1025) }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("detached provider remains Socket-compatible when OIDC is unavailable", async () => {
  const { child, url } = await startProvider(SOCKET_TOKEN, {});
  try {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ github_oidc_audience: AUDIENCE }) });
    assert.deepEqual(await response.json(), { token: SOCKET_TOKEN });
    assert.ok(child.spawnargs.every((arg) => !arg.includes(SOCKET_TOKEN)));
  } finally { child.kill(); }
});

test("live runner IPC-to-HTTP OIDC handoff", {
  skip: process.env.AEGIS_LIVE_GITHUB_OIDC !== "true",
}, async () => {
  const source = runnerOIDCEnvironment();
  assert.ok(source.requestURL && source.requestToken, "runner OIDC environment missing");
  const { child, url } = await startProvider(SOCKET_TOKEN);
  try {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ github_oidc_audience: AUDIENCE }) });
    const body = await response.json();
    // Boolean assertions ensure test diagnostics cannot print credentials.
    assert.ok(body.token === SOCKET_TOKEN, "Socket credential missing");
    assert.ok(typeof body.github_oidc_jwt === "string" && body.github_oidc_jwt.length > 0, "runner identity missing");
    const claims = JSON.parse(Buffer.from(body.github_oidc_jwt.split(".")[1], "base64url").toString("utf8"));
    assert.ok(claims.exp * 1000 > Date.now(), "runner identity expired");
    assert.ok(claims.aud === AUDIENCE || (Array.isArray(claims.aud) && claims.aud.includes(AUDIENCE)), "runner audience incorrect");
  } finally { child.kill(); }
});
