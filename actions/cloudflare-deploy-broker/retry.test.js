const assert = require("node:assert/strict");
const test = require("node:test");
const { requestDeployment } = require("./retry.cjs");

function recordWaits(now = () => 0) {
  const waits = [];
  return {
    waits,
    dependencies: {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      now,
    },
  };
}

function sequence(responses) {
  return async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
}

function rejectsWith(promise, text) {
  return assert.rejects(promise, (error) => {
    assert.ok(error.message.includes(text), error.message);
    return true;
  });
}

const inProgress = {
  status: 409,
  body: JSON.stringify({ error: "operation_in_progress" }),
};
const completed = {
  status: 200,
  body: JSON.stringify({ operationId: "operation-1" }),
};

test("preserves transient HTTP response retries", async () => {
  const { waits, dependencies } = recordWaits();
  const result = await requestDeployment(
    sequence([
      { status: 503, body: "unavailable" },
      { status: 502, body: "bad gateway" },
      completed,
    ]),
    dependencies,
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("preserves transient request retries", async () => {
  let attempts = 0;
  const { waits, dependencies } = recordWaits();
  const result = await requestDeployment(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("connection closed");
    return completed;
  }, dependencies);

  assert.equal(result.response.status, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("polls an in-progress operation until it completes", async () => {
  const responses = [inProgress, completed];
  let requests = 0;
  const { waits, dependencies } = recordWaits();
  const result = await requestDeployment(async () => {
    requests += 1;
    return sequence(responses)();
  }, dependencies);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.result, { operationId: "operation-1" });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [10_000]);
});

test("resets exponential backoff after an in-progress response", async () => {
  const { waits, dependencies } = recordWaits();
  const result = await requestDeployment(
    sequence([
      { status: 503, body: "unavailable" },
      { status: 502, body: "bad gateway" },
      inProgress,
      inProgress,
      { status: 500, body: "internal server error" },
      completed,
    ]),
    dependencies,
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(waits, [1_000, 2_000, 10_000, 10_000, 1_000]);
});

test("retries through four consecutive transient responses", async () => {
  const unavailable = { status: 503, body: "unavailable" };
  const { waits, dependencies } = recordWaits();
  const result = await requestDeployment(
    sequence([unavailable, unavailable, unavailable, unavailable, completed]),
    dependencies,
  );

  assert.equal(result.response.status, 200);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000]);
});

test("fails before exponential backoff exceeds 60 seconds in total", async () => {
  let requests = 0;
  const { waits, dependencies } = recordWaits();
  await rejectsWith(
    requestDeployment(async () => {
      requests += 1;
      return { status: 500, body: "internal server error" };
    }, dependencies),
    "total transient retry delay exceed 60 seconds",
  );

  assert.equal(requests, 6);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

for (const status of [429, 500, 599]) {
  test(`retries transient HTTP ${status} responses`, async () => {
    let requests = 0;
    const { waits, dependencies } = recordWaits();
    const result = await requestDeployment(async () => {
      requests += 1;
      return requests === 1
        ? { status, body: "transient" }
        : { status: 200, body: "{}" };
    }, dependencies);

    assert.equal(result.response.status, 200);
    assert.deepEqual(waits, [1_000]);
  });
}

test("retains the broker error in retry logs and the exhausted-budget error", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const message = "GitHub returned\ninvalid JSON";
  const detail =
    "Cloudflare Deploy Broker returned transient HTTP 502 [github_invalid_response]: GitHub returned invalid JSON";
  await rejectsWith(
    requestDeployment(
      async () => ({
        status: 502,
        body: JSON.stringify({ error: "github_invalid_response", message }),
      }),
      { sleep: async () => {}, now: () => 0 },
    ),
    `${detail}: exponential backoff requires 32 seconds, which would make total transient retry delay exceed 60 seconds (already delayed 31 seconds)`,
  );
  assert.equal(log.mock.callCount(), 5);
  assert.deepEqual(log.mock.calls[0].arguments, [
    `${detail}; retrying in 1 seconds (1 of 60 seconds total retry delay)`,
  ]);
});

test("omits unstructured gateway response bodies from retry errors", async () => {
  await rejectsWith(
    requestDeployment(
      async () => ({
        status: 502,
        body: "<html>private proxy detail</html>",
        retryAfter: "61",
      }),
      { sleep: async () => {}, now: () => 0 },
    ),
    'Cloudflare Deploy Broker returned transient HTTP 502: Retry-After "61" requires 61 seconds, which would make total transient retry delay exceed 60 seconds (already delayed 0 seconds)',
  );
});

test("honors Retry-After delta seconds over exponential backoff", async () => {
  const { waits, dependencies } = recordWaits(() =>
    Date.parse("2026-09-27T20:00:00Z"),
  );
  await requestDeployment(
    sequence([
      { status: 429, body: "rate limited", retryAfter: "12" },
      { status: 200, body: "{}" },
    ]),
    dependencies,
  );

  assert.deepEqual(waits, [12_000]);
});

test("honors Retry-After HTTP dates", async () => {
  const now = Date.parse("2026-09-27T20:00:00Z");
  const { waits, dependencies } = recordWaits(() => now);
  await requestDeployment(
    sequence([
      {
        status: 503,
        body: "unavailable",
        retryAfter: "Sun, 27 Sep 2026 20:00:09 GMT",
      },
      { status: 200, body: "{}" },
    ]),
    dependencies,
  );

  assert.deepEqual(waits, [9_000]);
});

test("fails clearly when Retry-After exceeds the remaining delay budget", async () => {
  await rejectsWith(
    requestDeployment(
      async () => ({ status: 429, body: "rate limited", retryAfter: "61" }),
      {
        sleep: async () => {
          throw new Error("unexpected sleep");
        },
        now: () => 0,
      },
    ),
    'Cloudflare Deploy Broker returned transient HTTP 429: Retry-After "61" requires 61 seconds, which would make total transient retry delay exceed 60 seconds',
  );
});

test("counts multiple Retry-After delays toward the same 60-second budget", async () => {
  const { waits, dependencies } = recordWaits();
  await rejectsWith(
    requestDeployment(
      sequence([
        { status: 429, body: "rate limited", retryAfter: "40" },
        { status: 503, body: "unavailable", retryAfter: "21" },
      ]),
      dependencies,
    ),
    'Cloudflare Deploy Broker returned transient HTTP 503: Retry-After "21" requires 21 seconds, which would make total transient retry delay exceed 60 seconds (already delayed 40 seconds)',
  );
  assert.deepEqual(waits, [40_000]);
});

test("uses Retry-After from a transient OIDC response error", async () => {
  let attempts = 0;
  const { waits, dependencies } = recordWaits();
  await requestDeployment(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("GitHub OIDC request failed (HTTP 503)"), {
        retryAfter: "5",
        status: 503,
      });
    }
    return { status: 200, body: "{}" };
  }, dependencies);

  assert.deepEqual(waits, [5_000]);
});

test("does not retry unrelated conflict responses", async () => {
  let requests = 0;
  const result = await requestDeployment(
    async () => {
      requests += 1;
      return {
        status: 409,
        body: JSON.stringify({ error: "idempotency_conflict" }),
      };
    },
    {
      sleep: async () => {
        throw new Error("unexpected sleep");
      },
      now: () => 0,
    },
  );

  assert.equal(result.response.status, 409);
  assert.equal(requests, 1);
});

test("stops polling an in-progress operation after the timeout", async () => {
  let now = 0;
  let requests = 0;
  const waits = [];
  await rejectsWith(
    requestDeployment(
      async () => {
        requests += 1;
        return inProgress;
      },
      {
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
        },
        now: () => now,
        operationPollIntervalMs: 10_000,
        operationPollTimeoutMs: 25_000,
      },
    ),
    "Timed out waiting for the in-progress Cloudflare Deploy Broker deployment",
  );
  assert.equal(requests, 4);
  assert.deepEqual(waits, [10_000, 10_000, 5_000]);
});
