const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { identity, retire, quiesceAsync } = require("./linux-lifecycle.cjs");
const { main: post } = require("./post.cjs");

function fixture({ config = true, journal = true, denied = false, uninstallFails = false } = {}) {
  const calls = [];
  const installed = { test_token_url: "http://127.0.0.1:1234/current-job" };
  const fail = (status) => { throw Object.assign(new Error("command failed"), { status }); };
  return { calls, installed, run(command, args) {
    assert.equal(command, "sudo");
    assert.equal(args[0], "-n");
    calls.push(args.slice(1));
    if (denied) fail(1);
    if (args[1] === "test") {
      if (args[3].endsWith("config.json") ? !config : !journal) fail(1);
    } else if (args[1] === "cat") {
      return JSON.stringify(installed);
    } else if (args[1] === "/usr/bin/aegis") {
      assert.deepEqual(args.slice(2), ["uninstall", "--config", "/etc/aegis/config.json"]);
      if (uninstallFails) fail(1);
      config = journal = false;
    }
    return "";
  } };
}

test("fresh hosts need no uninstall; repeated retirement is harmless", () => {
  const fresh = fixture({ config: false, journal: false });
  retire(fresh);
  assert.equal(fresh.calls.some((a) => a.includes("uninstall")), false);
  const old = fixture();
  retire(old);
  retire(old);
  assert.equal(old.calls.filter((a) => a.includes("uninstall")).length, 1);
});

test("permission, partial-state, and restoration failures propagate", () => {
  for (const options of [{ denied: true }, { config: false }, { journal: false }, { uninstallFails: true }]) {
    assert.throws(() => retire(fixture(options)));
  }
});

test("post cleanup only removes the installation belonging to this invocation", () => {
  const f = fixture();
  assert.throws(() => retire({ run: f.run, expectedIdentity: identity({ test_token_url: "other-job" }) }), /another invocation/);
  assert.equal(f.calls.some((a) => a.includes("uninstall")), false);
  retire({ run: f.run, expectedIdentity: identity(f.installed) });
  assert.equal(f.calls.filter((a) => a.includes("uninstall")).length, 1);
});

test("identity requires a CI provider and persists only a digest", () => {
  assert.throws(() => identity({}), /identity/);
  assert.match(identity({ test_token_url: "secret-route" }), /^[a-f0-9]{64}$/);
});

test("post uploads before cleanup, including when upload fails", { skip: process.platform !== "linux" }, async () => {
  for (const uploadFails of [false, true]) {
    const calls = [];
    await post({
      env: { STATE_installation_identity: "owner" },
      upload: async () => { calls.push("upload"); if (uploadFails) throw new Error("upload failed"); },
      cleanup: ({ expectedIdentity }) => { assert.equal(expectedIdentity, "owner"); calls.push("cleanup"); },
    });
    assert.deepEqual(calls, ["upload", "cleanup"]);
  }
});

test("cleanup failure fails post; report-only callers never uninstall", { skip: process.platform !== "linux" }, async () => {
  const cleanup = () => { throw new Error("restoration failed"); };
  await assert.rejects(post({ env: { STATE_installation_identity: "owner" }, upload: async () => {}, cleanup }), /restoration failed/);
  await post({ env: {}, upload: async () => {}, cleanup });
});

test("upload and retirement overlap after snapshot and are both drained on retirement failure", async () => {
  const upload = Promise.withResolvers();
  let snapshot = false;
  let finished = false;
  const result = post({
    platform: "linux",
    env: { STATE_installation_identity: "owner", RUNNER_ENVIRONMENT: "self-hosted" },
    upload: async () => { snapshot = true; await upload.promise; },
    cleanup: async () => { assert.equal(snapshot, true); throw new Error("retirement failed"); },
  }).finally(() => { finished = true; });
  const checked = assert.rejects(result, /retirement failed/);
  await new Promise(setImmediate);
  assert.equal(finished, false);
  upload.resolve();
  await checked;
});

test("job-end command passes only installation digest and caps the entire child lifetime", async () => {
  const owner = identity({ test_token_url: "http://localhost/private-provider-route" });
  let called = 0;
  await quiesceAsync({ expectedIdentity: owner, launch(command, args, options) {
    called++;
    assert.equal(command, "sudo");
    assert.deepEqual(args, ["-n", "/usr/bin/aegis", "end-job", "--config", "/etc/aegis/config.json", "--expected-identity", owner]);
    assert.equal(options.timeout, 500);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.stdio, "ignore");
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  } });
  assert.equal(called, 1);
  await assert.rejects(quiesceAsync({ expectedIdentity: "invalid", launch() { assert.fail("invalid identity executed command"); } }), /installation identity/);
  for (const code of [1, "ENOENT", "ETIMEDOUT"]) {
    await assert.rejects(quiesceAsync({ expectedIdentity: owner, launch() {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("sensitive subprocess diagnostic"), { code })));
      return child;
    } }), (error) => error.message.includes("continuing credential cleanup") && !error.message.includes("sensitive"));
  }
});

test("quiescing completes on CLI exit without waiting for unrelated descendant stdio", async () => {
  const owner = identity({ test_token_url: "http://localhost/current-job" });
  await quiesceAsync({ expectedIdentity: owner, launch() {
    const child = new EventEmitter();
    // Deliberately never emit close. No output is read and the CLI has exited.
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  } });
});

test("hosted cleanup quiesces this installation without uninstall; older clients do not block cleanup", async () => {
  const { cleanup } = require("./post.cjs");
  const owner = identity({ test_token_url: "http://localhost/current-job" });
  for (const fail of [false, true]) {
    let quiesced = false;
    await cleanup({ platform: "linux", env: { STATE_installation_identity: owner, RUNNER_ENVIRONMENT: "github-hosted" },
      cleanup() { assert.fail("hosted runner waited for full uninstall"); },
      quiesce: async ({ expectedIdentity }) => {
        assert.equal(expectedIdentity, owner); quiesced = true;
        if (fail) throw new Error("old client has no end-job command");
      },
    });
    assert.equal(quiesced, true);
  }
  for (const environment of ["self-hosted", "unknown", undefined]) {
    await assert.rejects(cleanup({ platform: "linux", env: { STATE_installation_identity: owner, RUNNER_ENVIRONMENT: environment },
      quiesce() { assert.fail("persistent runner must retain full restoration"); },
      cleanup: async () => { throw new Error("restoration failed"); },
    }), /restoration failed/);
  }
});
