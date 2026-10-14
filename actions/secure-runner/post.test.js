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

test("a stuck job-end CLI is killed promptly, then tokens revoke while audit upload continues", async () => {
  const { spawn } = require("node:child_process");
  const { identity, quiesceAsync } = require("../aegis-report/linux-lifecycle.cjs");
  const { cleanup } = require("../aegis-report/post.cjs");
  const upload = Promise.withResolvers();
  const revoked = Promise.withResolvers();
  const owner = identity({ test_token_url: "http://localhost/current-job" });
  const calls = [];
  let finished = false;
  let started;
  const post = main({ platform: "linux", env: { RUNNER_ENVIRONMENT: "github-hosted",
    STATE_aegis_action: "secure-runner", STATE_aegis_installation_identity: owner, STATE_socket_token: "fixture" },
    hooks: {
      aegis: async () => { calls.push("snapshot"); await upload.promise; },
      retire: (options) => cleanup({ ...options, cleanup() { assert.fail("hosted runner must not wait for shutdown"); },
        quiesce: (args) => quiesceAsync({ ...args, launch(_command, _args, options) {
          calls.push("quiesce"); started = Date.now();
          return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
        } }),
      }),
      socket: async () => { calls.push("revoke"); revoked.resolve(); },
      hardenRunner: async ({ revoke }) => { calls.push("flush"); await revoke(); },
      revokeLease: async () => { calls.push("lease"); },
    },
  }).finally(() => { finished = true; });
  try {
    await revoked.promise;
    assert.ok(Date.now() - started >= 500);
    assert.ok(Date.now() - started < 1500, "stuck CLI delayed credential revocation");
    assert.deepEqual(calls.slice(0, 4), ["snapshot", "quiesce", "revoke", "flush"]);
    assert.equal(finished, false, "audit upload should still be running independently");
  } finally { upload.resolve(); await post; }
});
