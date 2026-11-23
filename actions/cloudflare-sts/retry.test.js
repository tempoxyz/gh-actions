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
        return { status: 429, headers: { "retry-after": "400" } };
      },
      {
        isTransient: (r) => isTransientStatus(r.status),
        now: () => 0,
        sleep: async () => assert.fail("must not sleep"),
      },
    ),
    /exceeds the 360 second retry budget/,
  );
  assert.equal(calls, 1);
});

// A clock that advances only when the retry loop sleeps.
function rateLimitClock() {
  const clock = { time: 0, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.time += ms;
  };
  return clock;
}

test("waits out a rate limit past the ninety-second budget", async () => {
  // Cloudflare's window is five minutes, and the STS may pass on a 429 with
  // no useful Retry-After.
  const clock = rateLimitClock();
  let calls = 0;
  const response = await retry(
    async () => ({
      status: clock.time < 200_000 ? 429 : 200,
      headers: { "retry-after": "1" },
    }),
    {
      isTransient: (r) => isTransientStatus(r.status),
      now: clock.now,
      sleep: async (ms) => {
        calls++;
        await clock.sleep(ms);
      },
      random: () => 1,
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(calls, 9);
  assert.ok(clock.time > 90_000);
});

test("jitters rate-limited waits between half and all of the backoff", async () => {
  for (const [random, expected] of [
    [0, [500, 1000, 2000]],
    [0.5, [750, 1500, 3000]],
    [1, [1000, 2000, 4000]],
  ]) {
    const clock = rateLimitClock();
    let calls = 0;
    await retry(async () => ({ status: ++calls <= 3 ? 429 : 200 }), {
      isTransient: (r) => isTransientStatus(r.status),
      now: clock.now,
      sleep: clock.sleep,
      random: () => random,
    });
    assert.deepEqual(clock.sleeps, expected, `random ${random}`);
  }
});

test("stops at the rate-limit budget, without sleeping past it", async () => {
  const clock = rateLimitClock();
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls++;
        return { status: 429 };
      },
      {
        isTransient: (r) => isTransientStatus(r.status),
        now: clock.now,
        sleep: clock.sleep,
        random: () => 1,
      },
    ),
    /exceeds the 360 second retry budget/,
  );
  // 1+2+4+8+16+32+60*4 = 303 seconds; one more 60-second wait would end past 360.
  assert.equal(calls, 11);
  assert.equal(clock.time, 303_000);
});

test("returns the last 429 after the rate-limit retries run out", async () => {
  const clock = rateLimitClock();
  let calls = 0;
  const response = await retry(
    async () => {
      calls++;
      return { status: 429 };
    },
    {
      isTransient: (r) => isTransientStatus(r.status),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    },
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 16);
  assert.ok(clock.time <= 360_000);
});

test("a 5xx or network error while rate limited keeps the rate-limit budget", async () => {
  const clock = rateLimitClock();
  const answers = [429, 503, "network", 429, 200];
  let calls = 0;
  const response = await retry(
    async () => {
      const answer = answers[calls++];
      if (answer === "network") throw new Error("network");
      // Each request takes 25 seconds, so the sequence outlasts 90 seconds.
      clock.time += 25_000;
      return { status: answer };
    },
    {
      isTransient: (r) => isTransientStatus(r.status),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
      requestTimeoutMs: 60_000,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 5);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000]);
  assert.ok(clock.time > 90_000);
});

test("other transient failures keep the ninety-second budget and five retries", async () => {
  const clock = rateLimitClock();
  let calls = 0;
  const response = await retry(
    async () => {
      calls++;
      return { status: 503 };
    },
    {
      isTransient: (r) => isTransientStatus(r.status),
      now: clock.now,
      sleep: clock.sleep,
      random: () => assert.fail("only rate-limited waits are jittered"),
    },
  );
  assert.equal(response.status, 503);
  assert.equal(calls, 6);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000, 16_000]);
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

test("a slow token exchange completes without retrying inside its request timeout", async () => {
  let time = 0;
  let calls = 0;
  const response = await retry(
    async (timeoutMs) => {
      calls++;
      assert.equal(timeoutMs, 60_000);
      time += 35_000;
      return { status: 200 };
    },
    {
      requestTimeoutMs: 60_000,
      now: () => time,
      sleep: async () => assert.fail("must not retry a successful exchange"),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("long exchange timeouts remain clipped to the ninety-second retry budget", async () => {
  let time = 0;
  const timeouts = [];
  const sleeps = [];
  await assert.rejects(
    retry(
      async (timeoutMs) => {
        timeouts.push(timeoutMs);
        time += timeoutMs;
        throw new Error("timed out");
      },
      {
        requestTimeoutMs: 60_000,
        now: () => time,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          time += delayMs;
        },
      },
    ),
    /retry budget/,
  );
  assert.deepEqual(timeouts, [60_000, 29_000]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(time, 90_000);
});
