const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { main } = require("./post.cjs");
const { runHardenRunnerAsync } = require("./run.cjs");
const { retireAsync } = require("../aegis-report/linux-lifecycle.cjs");

test("lease revocation waits for asynchronous telemetry cleanup, even when it fails", async () => {
  for (const fail of [false, true]) {
    const flush = Promise.withResolvers();
    let revoked = false;
    const post = main({
      env: { STATE_token: "step_test_short_lived_api_key" },
      run: () => flush.promise,
      revoke: async () => { revoked = true; },
    });
    const checked = fail ? assert.rejects(post, /flush failed/) : post;
    assert.equal(revoked, false);
    if (fail) flush.reject(new Error("flush failed"));
    else flush.resolve();
    await checked;
    assert.equal(revoked, true);
  }
});

test("cleanup subprocess wrappers wait for close without blocking the event loop", async () => {
  for (const run of [
    (launch) => runHardenRunnerAsync("post", null, launch),
    (launch) => retireAsync({ expectedIdentity: "owner", launch }),
  ]) {
    let closed = false;
    await run((command, args, options) => {
      assert.equal(command, process.execPath);
      assert.equal(options.stdio, "inherit");
      const child = spawn(command, ["-e", "process.stdin.once('data', () => process.exit(0))"], { stdio: ["pipe", "inherit", "inherit"] });
      child.once("close", () => { closed = true; });
      setImmediate(() => child.stdin.end("finish"));
      return child;
    });
    assert.equal(closed, true);
    for (const event of ["error", "exit", "signal"]) {
      await assert.rejects(run(() => {
        const child = new EventEmitter();
        setImmediate(() => {
          if (event === "error") child.emit("error", new Error("launch failed"));
          else child.emit("close", event === "exit" ? 7 : null, event === "signal" ? "SIGTERM" : null);
        });
        return child;
      }), /launch failed|exit 7|signal SIGTERM/);
    }
  }
});
