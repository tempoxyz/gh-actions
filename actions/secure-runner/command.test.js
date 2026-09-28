const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { runCommand } = require("./command.cjs");

test("commands let the event loop progress and wait for the child to exit", async () => {
  let exited = false;
  let progressed = false;
  await runCommand(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(0))"], {},
    (command, args, options) => {
      const child = spawn(command, args, { ...options, stdio: ["pipe", "inherit", "inherit"] });
      child.once("close", () => { exited = true; });
      setImmediate(() => { progressed = true; child.stdin.end("finish"); });
      return child;
    });
  assert.equal(progressed, true);
  assert.equal(exited, true);
});

test("commands reject launch errors, nonzero exits, and timeouts", async () => {
  await assert.rejects(runCommand("/nonexistent-secure-runner-command", []), { code: "ENOENT" });
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(7)"]), /exit 7/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 }), /signal SIGTERM|exit 1/);
});
