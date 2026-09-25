const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  const timers = new Map();
  let receive;
  let requestOptions;
  const call = new EventEmitter();
  call.end = () => {};
  call.destroy = () => {
    call.destroyed = true;
  };
  const response = new EventEmitter();
  response.setEncoding = () => {};
  response.destroy = () => {
    response.destroyed = true;
  };
  response.statusCode = 200;
  response.headers = { "retry-after": "30" };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "http.cjs"), "utf8"),
    {
      module,
      Buffer,
      require: () => ({
        request(url, options, callback) {
          requestOptions = options;
          receive = callback;
          return call;
        },
      }),
      setTimeout(callback, ms) {
        timers.set(1, { callback, ms });
        return 1;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  );
  return {
    request: module.exports.request,
    call,
    response,
    timers,
    headers: () => receive(response),
    options: () => requestOptions,
    expire: () => timers.get(1).callback(),
  };
}

for (const receiveHeaders of [false, true]) {
  test(`wall-clock timeout destroys a request stalled ${receiveHeaders ? "in its body" : "before headers"}`, async () => {
    const h = harness();
    const pending = h.request("https://sts.example", { timeoutMs: 123 });
    assert.equal(h.timers.get(1).ms, 123);
    assert.equal(h.options().timeoutMs, undefined);
    if (receiveHeaders) {
      h.headers();
      h.response.emit("data", "partial");
    }
    h.expire();
    await assert.rejects(pending, /HTTPS request timed out/);
    assert.equal(h.call.destroyed, true);
    if (receiveHeaders) assert.equal(h.response.destroyed, true);
    assert.equal(h.timers.size, 0);
  });
}

test("successful responses preserve headers and clear the default deadline", async () => {
  const h = harness();
  const pending = h.request("https://sts.example");
  assert.equal(h.timers.get(1).ms, 10_000);
  h.headers();
  h.response.emit("data", "ok");
  h.response.emit("end");
  const result = await pending;
  assert.equal(result.body, "ok");
  assert.equal(result.headers["retry-after"], "30");
  assert.equal(h.timers.size, 0);
  assert.equal(h.call.destroyed, undefined);
});

test("body errors are sanitized and cancel the timer", async () => {
  const h = harness();
  const pending = h.request("https://sts.example");
  h.headers();
  h.response.emit("error", new Error("secret token in transport error"));
  await assert.rejects(pending, { message: "HTTPS request failed" });
  assert.equal(h.timers.size, 0);
});

test("oversized bodies reject and destroy the stream", async () => {
  const h = harness();
  const pending = h.request("https://sts.example");
  h.headers();
  h.response.emit("data", "x".repeat(129 * 1024));
  await assert.rejects(pending, /response is too large/);
  assert.equal(h.response.destroyed, true);
  assert.equal(h.call.destroyed, true);
  assert.equal(h.timers.size, 0);
});
