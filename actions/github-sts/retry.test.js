const assert = require("node:assert/strict");
const test = require("node:test");
const { isTransientStatus, retry, retryAfterMs } = require("./retry.js");

test("interprets retry deadlines without applying a non-exhausted reset", () => {
  const now = Date.UTC(2026, 8, 23, 12);
  const cases = [
    [{ "retry-after": "120" }, 120_000],
    [{ "retry-after": new Date(now + 90_000).toUTCString() }, 90_000],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 3600) }, 3_600_000],
    [{ "retry-after": "30", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 120) }, 120_000],
    [{ "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(now / 1000 + 3600) }, 60_000],
    [{ "retry-after": "invalid" }, 60_000],
    [{ "retry-after": "-5" }, 60_000],
    [{ "retry-after": "99999999999999999999999999999" }, 60_000],
    [{ "retry-after": new Date(now - 90_000).toUTCString() }, 60_000],
    [{}, 60_000],
  ];
  for (const [headers, expected] of cases) {
    assert.equal(retryAfterMs({ status: 429, headers }, now), expected);
  }
  assert.equal(retryAfterMs({ status: 503 }, now), 0);
});

test("honors the server deadline, including request time in the budget", async () => {
  let clock = 0;
  let attempts = 0;
  const delays = [];
  const result = await retry(async () => {
    clock += 10_000;
    return ++attempts === 1 ? { status: 429, headers: { "retry-after": "120" } } : { status: 200 };
  }, {
    isTransient: (r) => isTransientStatus(r.status),
    getDelayMs: (r) => retryAfterMs(r, clock),
    deadlineMs: 150_000,
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
  });
  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [120_000]);
  assert.equal(clock, 140_000);
});

test("does not shorten an hourly reset or retry a budget error", async () => {
  const now = Date.UTC(2026, 8, 23, 12);
  let attempts = 0;
  await assert.rejects(retry(async () => {
    attempts++;
    return { status: 429, headers: { "retry-after": "3600" } };
  }, {
    isTransient: () => true,
    getDelayMs: (r) => retryAfterMs(r, now),
    deadlineMs: now + 300_000,
    now: () => now,
    sleep: async () => assert.fail("must not sleep past budget"),
  }), /next retry permitted at 2026-09-23T13:00:00.000Z/);
  assert.equal(attempts, 1);
});

test("does not send another request if scheduling resumes after the deadline", async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(retry(async () => {
    attempts++;
    return { status: 503 };
  }, {
    isTransient: () => true, deadlineMs: 10_000, now: () => clock,
    sleep: async () => { clock = 10_001; },
  }), /retry timeout exceeded/);
  assert.equal(attempts, 1);
});

test("does not retry a nested OIDC retry-budget failure", async () => {
  let attempts = 0;
  await assert.rejects(retry(() => retry(async () => {
    attempts++;
    return { status: 429, headers: { "retry-after": "3600" } };
  }, {
    isTransient: () => true, getDelayMs: retryAfterMs,
    deadlineMs: Date.now() + 300_000,
  }), { sleep: async () => assert.fail("must not retry an exhausted inner budget") }), /next retry permitted/);
  assert.equal(attempts, 1);
});

test("recognizes transient HTTP statuses", () => {
  for (const status of [408, 425, 429, 500, 503]) {
    assert.equal(isTransientStatus(status), true);
  }
  for (const status of [200, 400, 401, 404]) {
    assert.equal(isTransientStatus(status), false);
  }
});

test("retries transient results five times with exponential backoff", async () => {
  const delays = [];
  let attempts = 0;
  const result = await retry(
    async () => {
      attempts += 1;
      return attempts < 6 ? { status: 503 } : { status: 204 };
    },
    {
      label: "test",
      isTransient: (response) => isTransientStatus(response.status),
      random: () => 0,
      sleep: async (milliseconds) => delays.push(milliseconds),
    },
  );

  assert.deepEqual(result, { status: 204 });
  assert.equal(attempts, 6);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
});

test("does not retry non-transient results", async () => {
  let attempts = 0;
  const result = await retry(
    async () => {
      attempts += 1;
      return { status: 400 };
    },
    { isTransient: (response) => isTransientStatus(response.status), sleep: async () => {} },
  );

  assert.deepEqual(result, { status: 400 });
  assert.equal(attempts, 1);
});

test("retries rejected requests and throws after the retry bound", async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts += 1;
        throw new Error("network down");
      },
      { sleep: async () => {} },
    ),
    /network down/,
  );
  assert.equal(attempts, 6);
});

test("backoff carries up to 25% jitter without touching server-specified delays", async () => {
  const { JITTER_RATIO } = require("./retry.js");
  assert.equal(JITTER_RATIO, 0.25);
  const delays = [];
  let attempts = 0;
  await retry(
    async () => (++attempts < 6 ? { status: 503 } : { status: 204 }),
    {
      isTransient: (response) => isTransientStatus(response.status),
      random: () => 1,
      sleep: async (milliseconds) => delays.push(milliseconds),
    },
  );
  assert.deepEqual(delays, [1250, 2500, 5000, 10000, 20000]);

  const served = [];
  attempts = 0;
  await retry(
    async () => (++attempts < 2 ? { status: 429, headers: { "retry-after": "3" } } : { status: 204 }),
    {
      isTransient: (response) => isTransientStatus(response.status),
      getDelayMs: (response) => retryAfterMs(response, 0),
      random: () => 1,
      sleep: async (milliseconds) => served.push(milliseconds),
    },
  );
  assert.deepEqual(served, [3000]);
});
