const https = require("node:https");
const MAX_RESPONSE_BYTES = 64 * 1024;

function request(url, options = {}, body) {
  const { timeoutMs = 10_000, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    let call;
    let incoming;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const fail = () => finish(new Error("HTTPS request failed"));
    // A wall-clock deadline covers DNS, TLS, response headers, and stalled bodies.
    const timer = setTimeout(() => {
      finish(new Error("HTTPS request timed out"));
      incoming?.destroy();
      call?.destroy();
    }, timeoutMs);
    try {
      call = https.request(url, requestOptions, (response) => {
        incoming = response;
        let value = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("error", fail);
        response.on("aborted", fail);
        response.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(new Error("HTTPS response is too large"));
            response.destroy();
            call.destroy();
            return;
          }
          value += chunk;
        });
        response.on("end", () =>
          finish(null, {
            status: response.statusCode,
            headers: response.headers,
            body: value,
          }),
        );
      });
      call.on("error", fail);
      if (body !== undefined) call.write(body);
      call.end();
    } catch {
      fail();
    }
  });
}

module.exports = { request };
