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
        resolve({ status: response.statusCode, headers: response.headers, body: value }),
      );
    });
    call.on("error", () => reject(new Error("HTTPS request failed")));
    if (body !== undefined) call.write(body);
    call.end();
  });
}

const MAX_RATE_LIMIT_DELAY_MS = 2 * 60 * 1000;

function header(response, name) {
  const value = response.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function delayFromDate(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function delayFromEpoch(value, now) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const timestamp = number >= 1e12 ? number : number * 1000;
  return Math.max(0, timestamp - now);
}

// Prefer the server's explicit retry instruction. Some STS deployments return
// Retry-After while others include the reset time in their JSON error body.
function rateLimitDelay(response, now = Date.now()) {
  const retryAfter = header(response, "retry-after");
  if (typeof retryAfter === "string") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const delay = delayFromDate(retryAfter, now);
    if (delay !== null) return delay;
  }

  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset"]) {
    const delay = delayFromEpoch(header(response, name), now);
    if (delay !== null) return delay;
  }

  try {
    const body = JSON.parse(response.body);
    for (const name of ["retry_after_ms", "retryAfterMs"]) {
      const delay = Number(body[name]);
      if (Number.isFinite(delay) && delay >= 0) return delay;
    }
    for (const name of ["retry_after", "retryAfter"]) {
      const delay = Number(body[name]);
      if (Number.isFinite(delay) && delay >= 0) return delay * 1000;
    }
    for (const name of ["retry_at", "retryAt", "reset_at", "resetAt"]) {
      const delay = delayFromDate(body[name], now) ?? delayFromEpoch(body[name], now);
      if (delay !== null) return delay;
    }
  } catch {}

  return null;
}

async function retryRateLimited(operation, options = {}) {
  const sleep =
    options.sleep ||
    ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const now = options.now || Date.now;
  const maxDelay = options.maxDelay ?? MAX_RATE_LIMIT_DELAY_MS;
  const deadline = now() + maxDelay;
  let attempt = 0;

  for (;;) {
    const response = await operation();
    if (response.status !== 429) return response;

    const requestedDelay = rateLimitDelay(response, now());
    const remaining = deadline - now();
    if (remaining < 100) {
      throw new Error("Rate limit retry delay exceeds the 2 minute limit");
    }
    if (
      requestedDelay !== null &&
      (requestedDelay > maxDelay || requestedDelay > remaining)
    ) {
      throw new Error(
        `Rate limit retry delay (${Math.ceil(requestedDelay / 1000)}s) exceeds the 2 minute limit`,
      );
    }
    const delay = Math.max(
      100,
      requestedDelay ?? Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000, remaining),
    );

    console.log(`STS exchange rate limited; retrying in ${Math.ceil(delay / 1000)}s`);
    await sleep(delay);
    attempt += 1;
  }
}

async function retry(operation, options = {}) {
  const retryHttpResponses = options.retryHttpResponses !== false;
  const sleep =
    options.sleep ||
    ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
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
    await sleep(2 ** attempt * 1000);
  }
  return last;
}

module.exports = {
  MAX_RATE_LIMIT_DELAY_MS,
  endpoint,
  rateLimitDelay,
  request,
  retry,
  retryRateLimited,
};
