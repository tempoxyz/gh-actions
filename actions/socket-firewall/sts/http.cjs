const https = require("node:https");

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

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
    call.on("error", reject);
    if (body !== undefined) call.write(body);
    call.end();
  });
}

async function retry(operation) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      last = await operation();
      if (!TRANSIENT.has(last.status) || attempt === 3) return last;
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  return last;
}

function host(dev) {
  if (dev === "true") return "socket-sts.tehq.dev";
  if (dev === "false") return "socket-sts.tehq.net";
  throw new Error("dev must be either true or false");
}

module.exports = { host, request, retry };
