const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { startHardenRunner } = require("./harden.cjs");

test("launches the existing StepSecurity handshake and installer without a shell and waits for close", async () => {
  const env = { GITHUB_STATE: "/runner/state" };
  const child = new EventEmitter();
  let finished = false;
  const running = startHardenRunner({ env, launch: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.join(__dirname, "../harden-runner/pre.cjs")]);
    assert.deepEqual(options, { env, stdio: "inherit" });
    return child;
  } }).then(() => { finished = true; });
  child.emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "wait for output streams to close too");
  child.emit("close", 0);
  await running;
});

test("reports launch failures, nonzero exits, and termination signals", async () => {
  for (const [event, args, expected] of [
    ["error", [new Error("spawn failed")], /spawn failed/],
    ["close", [1, null], /exit 1/],
    ["close", [null, "SIGTERM"], /signal SIGTERM/],
  ]) {
    const child = new EventEmitter();
    const running = startHardenRunner({ launch: () => child });
    const rejected = assert.rejects(running, expected);
    child.emit(event, ...args);
    await rejected;
  }
});

test("the real child records disabled-enforcement state for the shared post hook", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secure-runner-child-"));
  const state = path.join(directory, "state");
  try {
    await startHardenRunner({ env: {
      ...process.env,
      "INPUT_DISABLE-ENFORCEMENT": "true",
      GITHUB_STATE: state,
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    } });
    assert.equal(fs.readFileSync(state, "utf8"), "enforcement_disabled=true\n");
    assert.match(fs.readFileSync(path.join(directory, "summary"), "utf8"), /Runner security enforcement was explicitly disabled/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
