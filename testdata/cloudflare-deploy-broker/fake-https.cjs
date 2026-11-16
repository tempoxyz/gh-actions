// Preloaded with `node --require` by action tests: answers each HTTPS request
// with the next JSON response from FAKE_HTTPS_RESPONSES and appends the request
// to FAKE_HTTPS_CAPTURE, so a test can run an action's main.cjs end to end.
const fs = require("node:fs");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const responses = JSON.parse(process.env.FAKE_HTTPS_RESPONSES || "[]");

https.request = (url, options, handler) => {
  const call = new EventEmitter();
  let body = "";
  call.write = (chunk) => {
    body += chunk;
  };
  call.destroy = (error) => call.emit("error", error);
  call.end = () => {
    fs.appendFileSync(
      process.env.FAKE_HTTPS_CAPTURE,
      `${JSON.stringify({ url: String(url), headers: options.headers ?? {}, body })}\n`,
    );
    const next = responses.shift() ?? { status: 599, body: {} };
    setImmediate(() => {
      const response = new EventEmitter();
      response.statusCode = next.status;
      response.headers = {};
      response.setEncoding = () => {};
      handler(response);
      response.emit("data", JSON.stringify(next.body));
      response.emit("end");
    });
  };
  return call;
};
