const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { request } = require("./request.cjs");

function fakeCall() {
  const call = new EventEmitter();
  call.destroy = (error) => call.emit("error", error);
  call.end = () => undefined;
  call.write = () => undefined;
  return call;
}

test("fails a connection that has not completed after five seconds", async () => {
  const call = fakeCall();
  let timeout;
  let timeoutMs = 0;
  const pending = request(new URL("https://oidc.example/token"), {}, undefined, {
    clearTimeout: () => undefined,
    connectionTimeoutMs: 5_000,
    httpsRequest: () => call,
    setTimeout: (callback, milliseconds) => {
      timeout = callback;
      timeoutMs = milliseconds;
      return 1;
    },
  });
  const rejected = assert.rejects(pending, {
    message: "HTTPS connection to oidc.example timed out after 5 seconds",
  });

  assert.equal(timeoutMs, 5_000);
  timeout?.();
  await rejected;
});

test("clears the connection deadline after TLS and returns Retry-After", async (t) => {
  const call = fakeCall();
  let responseHandler;
  const clearTimeout = t.mock.fn();
  const pending = request(new URL("https://oidc.example/token"), {}, undefined, {
    clearTimeout,
    httpsRequest: (_url, _options, handler) => {
      responseHandler = handler;
      return call;
    },
    setTimeout: () => 1,
  });
  const socket = new EventEmitter();
  socket.connecting = true;
  call.emit("socket", socket);
  socket.emit("secureConnect");

  const response = new EventEmitter();
  response.headers = { "retry-after": "7" };
  response.setEncoding = () => undefined;
  response.statusCode = 429;
  responseHandler?.(response);
  response.emit("data", "rate limited");
  response.emit("end");

  assert.deepEqual(await pending, {
    body: "rate limited",
    retryAfter: "7",
    status: 429,
  });
  assert.ok(clearTimeout.mock.calls.some((c) => c.arguments[0] === 1));
});
