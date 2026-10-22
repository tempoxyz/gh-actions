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

// Records each timer by its duration so tests can fire one deadline.
function fakeTimers() {
  const timers = new Map();
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeout: (callback, milliseconds) => {
      timers.set(milliseconds, callback);
      return milliseconds;
    },
    clearTimeout: (id) => cleared.push(id),
  };
}

function tlsSocket(call) {
  const socket = new EventEmitter();
  socket.connecting = true;
  call.emit("socket", socket);
  socket.emit("secureConnect");
}

test("fails a connection that has not completed after five seconds", async () => {
  const call = fakeCall();
  const clock = fakeTimers();
  const pending = request(new URL("https://oidc.example/token"), {}, undefined, {
    ...clock,
    connectionTimeoutMs: 5_000,
    httpsRequest: () => call,
  });
  const rejected = assert.rejects(pending, {
    message: "HTTPS connection to oidc.example timed out after 5 seconds",
  });

  clock.timers.get(5_000)();
  await rejected;
});

test("fails a request whose response stalls after TLS", async () => {
  const call = fakeCall();
  const clock = fakeTimers();
  const pending = request(new URL("https://broker.example.com/v1/deploy"), {}, "{}", {
    ...clock,
    httpsRequest: () => call,
  });
  const rejected = assert.rejects(pending, {
    message:
      "HTTPS request to broker.example.com did not complete within 600 seconds",
  });
  tlsSocket(call);

  assert.ok(clock.cleared.includes(5_000));
  clock.timers.get(600_000)();
  await rejected;
});

test("clears both deadlines and returns Retry-After when the response completes", async () => {
  const call = fakeCall();
  const clock = fakeTimers();
  let responseHandler;
  const pending = request(new URL("https://oidc.example/token"), {}, undefined, {
    ...clock,
    httpsRequest: (_url, _options, handler) => {
      responseHandler = handler;
      return call;
    },
  });
  tlsSocket(call);

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
  assert.ok(clock.cleared.includes(5_000));
  assert.ok(clock.cleared.includes(600_000));
});
