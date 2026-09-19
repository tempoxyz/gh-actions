const assert = require("node:assert/strict");
const test = require("node:test");
const { identity, retire } = require("./linux-lifecycle.cjs");
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
