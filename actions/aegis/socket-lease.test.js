const assert = require("node:assert/strict");
const test = require("node:test");
const { once } = require("node:events");
const http = require("node:http");
const { createSocketLease, RENEW_BEFORE_MS, RETRY_AFTER_MS } = require("./socket-lease.cjs");
const { createTokenServer } = require("./token-server.cjs");
const { retireProvider, startProvider } = require("./token-provider.cjs");

const INITIAL = "socket-fixture-initial-" + "a".repeat(32);
const NEXT = "socket-fixture-replacement-" + "b".repeat(32);
const HOUR = 3_600_000;
const START = 1_800_000_000_000;
const iso = (time) => new Date(time).toISOString();

function fixture(overrides = {}) {
  let time = START;
  const timers = new Set(), assertions = [], exchanges = [], revoked = [];
  const lease = createSocketLease({ token: INITIAL, expiresAt: iso(START + HOUR),
    endpoint: "socket-sts.tempoxyz.net", oidc: { requestURL: "https://runner.example/token", requestToken: "runner-fixture" } }, {
    now: () => time,
    setTimer(fn, delay) { const timer = { fn, at: time + delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    createOidc(options) {
      return { async token(audience, mode) {
        assertions.push({ audience, mode, budget: options.budgetMs, source: options.env });
        return `assertion-${assertions.length}`;
      } };
    },
    async exchange(options) {
      exchanges.push(options);
      await options.getAssertion();
      return { token: NEXT, expiresAt: iso(time + HOUR) };
    },
    async revoke(token) { revoked.push(token); },
    ...overrides,
  });
  return { lease, timers, assertions, exchanges, revoked,
    now: () => time,
    setTime(value) { time = value; },
    async fire() {
      const timer = [...timers].sort((a, b) => a.at - b.at)[0];
      assert.ok(timer, "a renewal should be scheduled");
      timers.delete(timer); time = Math.max(time, timer.at);
      await timer.fn();
    },
  };
}

test("renews five minutes before expiry with fresh STS assertions across a long job", async () => {
  const f = fixture();
  assert.equal(f.lease.value(), INITIAL);
  assert.equal(f.exchanges.length, 0);
  assert.equal([...f.timers][0].at, START + HOUR - RENEW_BEFORE_MS);
  await f.fire();
  assert.equal(f.lease.value(), NEXT);
  assert.equal(f.exchanges[0].deadline - f.now(), 90_000);
  assert.deepEqual(await f.exchanges[0].getAssertion(), "assertion-2");
  assert.deepEqual(f.assertions.map((x) => [x.audience, x.mode.fresh, x.budget]), [
    ["socket-sts.tempoxyz.net", true, 90_000], ["socket-sts.tempoxyz.net", true, 90_000],
  ]);
  assert.deepEqual(f.assertions[0].source, {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.example/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-fixture",
  });
  assert.deepEqual(f.lease.close(), [INITIAL, NEXT], "keep both overlapping leases for cleanup");
  assert.equal(f.timers.size, 0);
});

test("one background renewal serves concurrent readers without waiting for the exchange", async () => {
  const pending = Promise.withResolvers();
  let calls = 0;
  const f = fixture({ exchange: () => { calls++; return pending.promise; } });
  const renewing = f.fire();
  await new Promise(setImmediate);
  for (let i = 0; i < 100; i++) assert.equal(f.lease.value(), INITIAL);
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0, "do not overlap renewals");
  pending.resolve({ token: NEXT, expiresAt: iso(f.now() + HOUR) });
  await renewing;
  assert.equal(f.lease.value(), NEXT);
  f.lease.close();
});

test("retries failed renewals, retains only unexpired credentials, and recovers after expiry", async () => {
  let calls = 0;
  const f = fixture({ exchange() {
    if (++calls === 1) throw new Error("private response and credentials");
    return Promise.resolve({ token: NEXT, expiresAt: iso(f.now() + HOUR) });
  } });
  await f.fire();
  assert.equal(f.lease.value(), INITIAL);
  assert.equal([...f.timers][0].at, f.now() + RETRY_AFTER_MS);
  f.setTime(START + HOUR);
  assert.equal(f.lease.value(), "", "never keep serving an expired Socket key");
  await f.fire();
  assert.equal(f.lease.value(), NEXT);
  assert.deepEqual(f.lease.close(), [NEXT]);
});

test("a job lasting multiple leases keeps renewing with a bounded set of overlapping tokens", async () => {
  let issued = 0;
  const f = fixture({ exchange: async ({ getAssertion }) => {
    await getAssertion();
    return { token: `socket-fixture-${++issued}-` + "c".repeat(32), expiresAt: iso(f.now() + HOUR) };
  } });
  for (let i = 0; i < 5; i++) {
    await f.fire();
    assert.equal(f.lease.value(), `socket-fixture-${i + 1}-` + "c".repeat(32));
  }
  assert.equal(f.assertions.length, 5);
  assert.equal(f.lease.close().length, 2);
});

test("cleanup freezes renewal immediately and revokes a mint that completes afterward", async () => {
  const pending = Promise.withResolvers();
  const f = fixture({ exchange: () => pending.promise });
  const renewing = f.fire();
  await new Promise(setImmediate);
  assert.deepEqual(f.lease.close(), [INITIAL]);
  assert.equal(f.lease.value(), "");
  assert.equal(f.timers.size, 0);
  pending.resolve({ token: NEXT, expiresAt: iso(f.now() + HOUR) });
  await renewing;
  assert.deepEqual(f.revoked, [NEXT]);
  assert.equal(f.lease.value(), "");
  assert.equal(f.timers.size, 0, "late completion must not restart renewal");
});

test("invalid or non-advancing replacements cannot replace or revoke the current credential", async () => {
  for (const result of [
    { token: NEXT, expiresAt: "invalid" },
    { token: NEXT, expiresAt: iso(START) },
    { token: NEXT, expiresAt: iso(START + HOUR) },
    { token: INITIAL, expiresAt: iso(START + 2 * HOUR) },
    { token: "invalid\nprivate-token", expiresAt: iso(START + 2 * HOUR) },
  ]) {
    const f = fixture({ exchange: async () => result });
    await f.fire();
    assert.equal(f.lease.value(), INITIAL);
    assert.deepEqual(f.revoked, result.token === NEXT ? [NEXT] : []);
    assert.deepEqual(f.lease.close(), [INITIAL]);
  }
});

async function serve(lease) {
  const { server, route } = createTokenServer(INITIAL, async () => "", lease);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}${route}` };
}

test("provider protocol publishes replacements, refuses expired keys, and retires every live lease", async () => {
  const f = fixture();
  const { server, url } = await serve(f.lease);
  try {
    assert.deepEqual(await (await fetch(url, { method: "POST" })).json(), { token: INITIAL });
    await f.fire();
    assert.deepEqual(await (await fetch(url, { method: "POST" })).json(), { token: NEXT });
    assert.deepEqual(await retireProvider(url), [INITIAL, NEXT]);
    assert.equal(f.lease.value(), "");
    assert.equal(f.timers.size, 0);
  } finally { f.lease.close(); server.closeAllConnections(); server.close(); }
  const expired = fixture({ exchange: async () => { throw new Error("unavailable"); } });
  const other = await serve(expired.lease);
  try {
    expired.setTime(START + HOUR);
    const response = await fetch(other.url, { method: "POST" });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "");
  } finally { expired.lease.close(); other.server.closeAllConnections(); other.server.close(); }
});

test("retirement validates the loopback capability and bounds stalled or unsafe responses", async () => {
  let calls = 0;
  const url = "http://127.0.0.1:1234/" + "a".repeat(43);
  for (const bad of ["https://remote.example/", url + "?query", url + "#fragment", url.replace("127.0.0.1", "localhost")]) {
    await assert.rejects(retireProvider(bad, { fetcher: async () => { calls++; } }),
      { message: "Socket token provider cleanup unavailable" });
  }
  assert.equal(calls, 0);
  for (const response of [new Response("", { status: 503 }), Response.json({ tokens: ["bad\nsecret"] }),
    new Response("x".repeat(65_537))]) {
    await assert.rejects(retireProvider(url, { fetcher: async (_url, options) => {
      assert.equal(options.redirect, "error"); assert.ok(options.signal); return response;
    } }), { message: "Socket token provider cleanup unavailable" });
  }
  assert.deepEqual(await retireProvider(url, { fetcher: async () => Response.json({ tokens: [INITIAL, INITIAL] }) }), [INITIAL]);
  await assert.rejects(retireProvider(url, { fetcher: async () => { throw new Error("private credential"); } }),
    { message: "Socket token provider cleanup unavailable" });
});

test("retirement aborts a real stalled HTTP response within its cleanup deadline", { timeout: 5_000 }, async (t) => {
  // A real pending socket keeps the event loop alive, as it does in production.
  // AbortSignal.timeout alone is unref'ed and cannot keep a mock stream alive
  // when this file runs by itself under the CI runner's Node version.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/` + "a".repeat(43);
  try {
    await assert.rejects(retireProvider(url), { message: "Socket token provider cleanup unavailable" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("detached IPC hands off lease metadata, keeps credentials out of argv, and exits after retirement", async () => {
  const { child, url } = await startProvider(INITIAL, {}, {
    endpoint: "socket-sts.tempoxyz.net", expiresAt: iso(Date.now() + HOUR),
  });
  // Production detaches/unrefs the provider so setup can exit. This test owns
  // the child and must keep its exit event referenced until it is observed.
  child.ref();
  const exited = once(child, "exit");
  try {
    assert.deepEqual(await (await fetch(url, { method: "POST" })).json(), { token: INITIAL });
    assert.ok(child.spawnargs.every((arg) => !arg.includes(INITIAL)));
    assert.deepEqual(await retireProvider(url), [INITIAL]);
    await exited;
  } finally { child.kill(); }
});
