const assert = require("node:assert/strict");
const test = require("node:test");
const { isTransientStatus, retry, retryAfterMs } = require("./retry.cjs");

test("parses seconds and HTTP dates without treating invalid numbers as dates", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  for (const [value, expected] of [
    ["30", 30_000],
    ["Thu, 24 Sep 2026 00:01:00 GMT", 60_000],
    ["Wed, 23 Sep 2026 00:00:00 GMT", 0],
    ["", null],
    ["junk", null],
    ["-1", null],
    ["1.5", null],
    ["999999999999999999999", Infinity],
  ])
    assert.equal(
      retryAfterMs({ headers: { "retry-after": value } }, now),
      expected,
    );
});

test("429 waits for Retry-After, then stops immediately on success", async () => {
  let time = 0;
  let calls = 0;
  const sleeps = [];
  const response = await retry(
    async () => ({
      status: ++calls === 1 ? 429 : 200,
      headers: { "retry-after": "30" },
    }),
    {
      isTransient: (r) => isTransientStatus(r.status),
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [30_000]);
});

test("never retries early when the provider deadline exceeds the budget", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        return { status: 429, headers: { "retry-after": "300" } };
      },
      {
        isTransient: (r) => isTransientStatus(r.status),
        now: () => 0,
        sleep: async () => assert.fail("must not sleep"),
      },
    ),
    /retry budget/,
  );
  assert.equal(calls, 1);
});

test("clips HTTP timeouts to the remaining budget and detects overslept deadlines", async () => {
  let time = 0;
  const timeouts = [];
  await assert.rejects(
    retry(
      async (timeoutMs) => {
        timeouts.push(timeoutMs);
        time += timeoutMs;
        throw new Error("timed out");
      },
      {
        maxElapsedMs: 15_000,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    ),
    /retry budget/,
  );
  assert.deepEqual(timeouts, [10_000, 4_000]);

  let calls = 0;
  time = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw new Error("network");
      },
      {
        now: () => time,
        sleep: async () => {
          time = 90_001;
        },
      },
    ),
    /deadline exceeded/,
  );
  assert.equal(calls, 1);
});

test("network and 5xx failures retain bounded backoff, while 409 is terminal", async () => {
  let calls = 0;
  const sleeps = [];
  const response = await retry(
    async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return { status: calls === 2 ? 503 : 409 };
    },
    {
      isTransient: (r) => isTransientStatus(r.status),
      sleep: async (ms) => sleeps.push(ms),
    },
  );
  assert.equal(response.status, 409);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});
