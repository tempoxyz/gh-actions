const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { flushHostedAgent } = require("./hosted-post.cjs");
const { main } = require("./post.cjs");

test("only explicitly hosted runners signal the agent and wait for telemetry", async () => {
  for (const environment of ["github-hosted", "self-hosted", undefined, "", "unknown"]) {
    let elapsed = 0;
    const writes = [];
    await flushHostedAgent({
      env: { RUNNER_ENVIRONMENT: environment }, platform: "linux",
      files: {
        existsSync: (file) => file === "/home/agent" || (file.endsWith("done.json") && elapsed >= 300),
        writeFileSync: (...args) => writes.push(args),
      },
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    });
    assert.equal(elapsed, environment === "github-hosted" ? 300 : 0);
    assert.deepEqual(writes, environment === "github-hosted" ? [["/home/agent/post_event.json", '{"event":"post"}']] : []);
  }
});

test("hosted flush uses each platform's protocol path and never resends an existing event", async () => {
  for (const [platform, directory, post, done] of [
    ["linux", "/home/agent", "/home/agent/post_event.json", "/home/agent/done.json"],
    ["darwin", "/opt/step-security", "/opt/step-security/post_event.json", "/opt/step-security/done.json"],
    ["win32", "D:\\agent", "D:\\agent\\post_event.json", "D:\\agent\\done.json"],
  ]) {
    const paths = [];
    await flushHostedAgent({
      env: { RUNNER_ENVIRONMENT: "github-hosted", STATE_agentDir: directory }, platform,
      files: { existsSync: (file) => { paths.push(file); return true; }, writeFileSync: () => assert.fail("duplicate event") },
      sleep: () => assert.fail("already complete"),
    });
    assert.deepEqual(paths, [directory, post, done]);
  }
});

test("unavailable and absent installations are not signalled", async () => {
  for (const state of [{ STATE_selfHosted: "true" }, { STATE_customVMImage: "true" }, { STATE_monitorStatusCode: "409" }, {}]) {
    await flushHostedAgent({
      env: { RUNNER_ENVIRONMENT: "github-hosted", ...state }, platform: "linux",
      files: { existsSync: () => false, writeFileSync: () => assert.fail("no installation") },
    });
  }
});

test("flush timeout is bounded and reported before the lease is revoked", async () => {
  let elapsed = 0;
  const order = [];
  const log = console.log;
  console.log = (line) => order.push(line);
  try {
    await main({
      env: { RUNNER_ENVIRONMENT: "github-hosted", STATE_inline_policy: "true" },
      flush: ({ env }) => flushHostedAgent({
        env, platform: "linux", now: () => elapsed,
        files: { existsSync: (file) => !file.endsWith("done.json"), writeFileSync: () => {} },
        sleep: async (ms) => { elapsed += ms; },
      }),
      run: async () => order.push("summary"), revoke: async () => order.push("revoke"),
    });
  } finally { console.log = log; }
  assert.equal(elapsed, 10_000);
  assert.match(order[0], /Timed out waiting for the StepSecurity agent's final telemetry upload/);
  assert.deepEqual(order.slice(1), ["summary", "revoke"]);
});

test("lease revocation and the upstream summary wait for hosted telemetry", async () => {
  const gate = Promise.withResolvers();
  const order = [];
  const post = main({
    env: { RUNNER_ENVIRONMENT: "github-hosted", STATE_inline_policy: "true" },
    flush: async () => { order.push("flush"); await gate.promise; },
    run: async () => order.push("summary"), revoke: async () => order.push("revoke"),
  });
  assert.deepEqual(order, ["flush"]);
  gate.resolve();
  await post;
  assert.deepEqual(order, ["flush", "summary", "revoke"]);
});

// Exercise the actual pinned bundle, not a mock of its duplicate-event guard.
// A vendor update must retain this contract or explicitly revise the adapter.
test("vendored post skips hosted teardown but still renders summaries on all platforms", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-post-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const platform of ["linux", "darwin", "win32"]) {
    const summary = path.join(dir, platform);
    fs.writeFileSync(summary, "");
    const script = `
      const fs = require("node:fs");
      const Module = require("node:module");
      const childProcess = require("node:child_process");
      const original = Module._load;
      const directory = ${JSON.stringify(platform === "linux" ? "/home/agent" : platform === "darwin" ? "/opt/step-security" : "C:\\agent")};
      const fakeFs = { ...fs, existsSync: (file) => file === directory || String(file).endsWith("post_event.json") || file === process.env.GITHUB_STEP_SUMMARY };
      Module._load = function(name, ...args) {
        if (name === "fs" || name === "node:fs") return fakeFs;
        if (name === "child_process" || name === "node:child_process") return Object.fromEntries(Object.keys(childProcess).map((key) => [key, () => { process.exitCode = 17; throw new Error("unexpected diagnostic or teardown subprocess"); }]));
        return original.call(this, name, ...args);
      };
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      process.kill = () => { throw new Error("unexpected agent termination"); };
      global.fetch = async () => ({ ok: true, text: async () => "Telemetry summary preserved" });
      require(${JSON.stringify(path.resolve(__dirname, "../../vendor/step-security/harden-runner/dist/post/index.js"))});
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, RUNNER_ENVIRONMENT: "github-hosted", USER: "runner", STATE_addSummary: "true", STATE_correlation_id: "test", GITHUB_REPOSITORY: "tempoxyz/gh-actions", GITHUB_RUN_ID: "1", GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /[Pp]ost step already executed, skipping/);
    assert.equal(fs.readFileSync(summary, "utf8"), "Telemetry summary preserved");
  }
});
