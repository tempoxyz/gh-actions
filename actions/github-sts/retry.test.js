const assert = require("node:assert/strict");
const test = require("node:test");
const { isTransientStatus, retry } = require("./retry.js");

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
