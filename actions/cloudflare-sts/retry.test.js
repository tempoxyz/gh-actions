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

test("retries transient results with exponential backoff", async () => {
  const delays = [];
  let attempts = 0;
  const result = await retry(
    async () => {
      attempts += 1;
      return attempts < 3 ? { status: 503 } : { status: 204 };
    },
    {
      label: "test",
      isTransient: (response) => isTransientStatus(response.status),
      sleep: async (milliseconds) => delays.push(milliseconds),
    },
  );

  assert.deepEqual(result, { status: 204 });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});
