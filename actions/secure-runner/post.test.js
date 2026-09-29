const assert = require("node:assert/strict");
const test = require("node:test");
const { main } = require("./post.cjs");

test("post overlaps independent work, retains retirement and lease dependencies, and drains failures", async () => {
  for (const fail of [false, true]) {
    const upload = Promise.withResolvers();
    const teardown = Promise.withResolvers();
    const socket = Promise.withResolvers();
    const flush = Promise.withResolvers();
    const started = Promise.withResolvers();
    const calls = [];
    let finished = false;
    const post = main({
      env: { STATE_aegis_action: "secure-runner", STATE_socket_token: "token" },
      hooks: {
        aegis: async () => { calls.push("snapshot"); await upload.promise; calls.push("uploaded"); },
        retire: async () => {
          assert.deepEqual(calls, ["snapshot"]);
          calls.push("retiring");
          await teardown.promise;
          if (fail) throw new Error("retire failed");
        },
        socket: async () => { calls.push("socket"); await socket.promise; },
        hardenRunner: async ({ revoke }) => {
          calls.push("flush");
          started.resolve();
          await flush.promise;
          await revoke();
        },
        revokeLease: async () => { calls.push("lease"); },
      },
    }).finally(() => { finished = true; });
    // Register rejection handling immediately, before releasing failure gates.
    const checked = fail ? assert.rejects(post, /Aegis cleanup: retire failed/) : post;
    assert.deepEqual(calls, ["snapshot", "retiring"]);
    teardown.resolve();
    await started.promise;
    assert.deepEqual(calls, ["snapshot", "retiring", "socket", "flush"]);
    assert.equal(finished, false);
    flush.resolve();
    socket.resolve();
    await new Promise(setImmediate);
    assert.equal(calls.at(-1), "lease");
    assert.equal(finished, false, "upload must finish even after a cleanup failure");
    upload.resolve();
    await checked;
    assert.equal(finished, true);
    assert.equal(calls.at(-1), "uploaded");
  }
});

test("all concurrent failures are collected after every cleanup is attempted", async () => {
  await assert.rejects(main({
    env: { STATE_aegis_action: "secure-runner", STATE_socket_token: "token" },
    hooks: Object.fromEntries(["aegis", "retire", "socket", "hardenRunner"].map((name) =>
      [name, async () => { throw new Error(name); }])),
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.cause.message).sort(), ["aegis", "hardenRunner", "retire", "socket"]);
    return true;
  });
});
