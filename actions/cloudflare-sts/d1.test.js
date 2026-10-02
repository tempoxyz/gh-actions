const assert = require("node:assert/strict");
const test = require("node:test");
const { HEALTH_CHECK_SQL, requireD1Ready } = require("./d1.cjs");

const token = "private-minted-token";
const accountId = "b".repeat(32);
const databaseId = "5a48cdd2-5207-4acd-9ad1-9767d20673e9";
const credentials = {
  token,
  accountId,
  expiresAt: new Date(60_000).toISOString(),
};
const list = { success: true, result: [{ uuid: databaseId }] };
const query = {
  success: true,
  result: [{ success: true, results: [{ 1: 1 }] }],
};
const response = (data, status = 200, headers = {}) => ({
  status,
  headers,
  body: JSON.stringify(data),
});

function harness(
  responses,
  { requestTime = 0, expiresAt = credentials.expiresAt } = {},
) {
  let time = 0;
  const calls = [];
  const sleeps = [];
  const logs = [];
  return {
    calls,
    sleeps,
    logs,
    now: () => time,
    run: () =>
      requireD1Ready(
        { ...credentials, expiresAt },
        {
          now: () => time,
          sleep: async (ms) => {
            sleeps.push(ms);
            time += ms;
          },
          log: (line) => logs.push(line),
          request: async (url, options, body) => {
            calls.push({ url, options, body });
            time += requestTime;
            const result =
              responses[Math.min(calls.length - 1, responses.length - 1)];
            if (result instanceof Error) throw result;
            return result;
          },
        },
      ),
  };
}

test("discovers a database and queries it using the same token and account", async () => {
  const check = harness([response(list), response(query)]);
  await check.run();
  assert.equal(check.calls.length, 2);
  assert.equal(
    check.calls[0].url.href,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=10`,
  );
  assert.equal(
    check.calls[1].url.href,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
  );
  assert.equal(check.calls[0].options.method, "GET");
  assert.equal(check.calls[1].options.method, "POST");
  assert.equal(
    check.calls[1].options.headers["content-type"],
    "application/json",
  );
  assert.deepEqual(JSON.parse(check.calls[1].body), { sql: HEALTH_CHECK_SQL });
  assert.equal(HEALTH_CHECK_SQL, "SELECT 1 /* Cloudflare STS health check */");
  for (const call of check.calls)
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(check.sleeps, []);
});

for (const status of [401, 403, 408, 425, 429, 500, 503]) {
  test(`retries HTTP ${status} during both discovery and query`, async () => {
    const failure = response({ success: false }, status);
    const check = harness([failure, response(list), failure, response(query)]);
    await check.run();
    assert.deepEqual(check.sleeps, [250, 500]);
    assert.equal(check.calls.length, 4);
    assert.equal(check.calls[2].url.href, check.calls[3].url.href);
  });
}

test("retries authentication code 10000 even with HTTP 400 or 200", async () => {
  const denial = { success: false, errors: [{ code: 10000, message: token }] };
  const check = harness([
    response(denial, 400),
    response(list),
    response(denial),
    response(query),
  ]);
  await check.run();
  assert.deepEqual(check.sleeps, [250, 500]);
  assert.ok(check.logs.every((line) => !line.includes(token)));
});

test("network errors retry without leaking credentials", async () => {
  const check = harness([
    new Error(token),
    response(list),
    new Error(token),
    response(query),
  ]);
  await check.run();
  assert.deepEqual(check.sleeps, [250, 500]);
  assert.ok(check.logs.every((line) => !line.includes(token)));
});

test("empty accounts fail explicitly without creating a database", async () => {
  const check = harness([response({ success: true, result: [] })]);
  await assert.rejects(check.run(), /no D1 databases/);
  assert.equal(check.calls.length, 1);
  assert.deepEqual(check.sleeps, []);
});

for (const data of [
  null,
  {},
  { success: false },
  { success: true, result: {} },
  { success: true, result: [{ uuid: "../tokens" }] },
]) {
  test(`rejects malformed database responses: ${JSON.stringify(data)}`, async () => {
    const check = harness([response(data)]);
    await assert.rejects(check.run(), /D1 readiness check/);
    assert.equal(check.calls.length, 1);
    assert.deepEqual(check.sleeps, []);
  });
}

for (const data of [
  { success: true },
  { success: true, result: [] },
  { success: true, result: [{ success: false }] },
]) {
  test(`does not accept a failed query: ${JSON.stringify(data)}`, async () => {
    const check = harness([response(list), response(data)]);
    await assert.rejects(check.run(), /unsuccessful query result/);
    assert.deepEqual(check.sleeps, []);
  });
}

test("invalid JSON and terminal errors fail without exposing provider bodies", async () => {
  for (const failure of [
    { status: 200, body: token },
    response({ success: false, errors: [{ message: token }] }, 404),
  ]) {
    const check = harness([failure]);
    await assert.rejects(
      check.run(),
      (error) => !error.message.includes(token),
    );
    assert.equal(check.calls.length, 1);
    assert.deepEqual(check.sleeps, []);
  }
});

test("discovery and query share a 30-second deadline and capped exponential backoff", async () => {
  const check = harness([response({ success: false }, 403)]);
  await assert.rejects(check.run(), /deadline/);
  assert.equal(check.now(), 30_000);
  assert.deepEqual(
    check.sleeps.slice(0, 6),
    [250, 500, 1000, 2000, 4000, 4000],
  );
  assert.ok(check.calls.every((call) => call.options.timeoutMs <= 10_000));

  const shared = harness([response(list), response({ success: false }, 403)], {
    requestTime: 10_000,
  });
  await assert.rejects(shared.run(), /deadline/);
  assert.equal(shared.calls[2].options.timeoutMs, 9750);
  assert.equal(shared.calls.length, 3);
});

test("honors Retry-After but never sleeps beyond the shared deadline", async () => {
  const check = harness([
    response({}, 429, { "retry-after": "2" }),
    response(list),
    response(query),
  ]);
  await check.run();
  assert.deepEqual(check.sleeps, [2000]);
  const excessive = harness([response({}, 429, { "retry-after": "30" })]);
  await assert.rejects(excessive.run(), /Retry-After/);
  assert.equal(excessive.calls.length, 1);
  assert.deepEqual(excessive.sleeps, []);
});

test("respects token expiry and rejects a success after the deadline", async () => {
  const expired = harness([], { expiresAt: new Date(0).toISOString() });
  await assert.rejects(expired.run(), /deadline/);
  assert.equal(expired.calls.length, 0);
  const expiring = harness([response(list), response({}, 403)], {
    expiresAt: new Date(1000).toISOString(),
  });
  await assert.rejects(expiring.run(), /deadline/);
  assert.equal(expiring.now(), 1000);
  const late = harness([response(list), response(query)], {
    requestTime: 15_000,
  });
  await assert.rejects(late.run(), /deadline/);
});
