const https = require("node:https");

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Step Security STS URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^[a-z0-9.-]+$/.test(url.hostname)
  ) {
    throw new Error("Step Security STS URL is invalid");
  }
  return { audience: url.hostname, origin: url.origin };
}

function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const call = https.request(url, options, (response) => {
      let value = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        value += chunk;
        if (value.length > 128 * 1024) {
          call.destroy(new Error("response is too large"));
        }
      });
      response.on("end", () =>
        resolve({ status: response.statusCode, body: value }),
      );
    });
    call.on("error", () => reject(new Error("HTTPS request failed")));
    if (body !== undefined) call.write(body);
    call.end();
  });
}

async function retry(operation, options = {}) {
  const retryHttpResponses = options.retryHttpResponses !== false;
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      last = await operation();
      if (
        !retryHttpResponses ||
        !TRANSIENT.has(last.status) ||
        attempt === 3
      ) {
        return last;
      }
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  return last;
}

module.exports = { endpoint, request, retry };
