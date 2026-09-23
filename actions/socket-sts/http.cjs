const https = require("node:https");

const REQUEST_TIMEOUT_MS = 10 * 1000;
const RETRY_ATTEMPTS = 4;

function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    let timeout;
    const clearRequestTimeout = () => clearTimeout(timeout);
    const call = https.request(url, options, (response) => {
      let value = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        value += chunk;
        if (value.length > 128 * 1024) {
          call.destroy(new Error("response is too large"));
        }
      });
      response.on("end", () => {
        clearRequestTimeout();
        resolve({ status: response.statusCode, headers: response.headers, body: value });
      });
    });
    timeout = setTimeout(() => {
      const error = new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      error.code = "ETIMEDOUT";
      call.destroy(error);
    }, REQUEST_TIMEOUT_MS);
    call.on("error", (error) => {
      clearRequestTimeout();
      reject(error);
    });
    if (body !== undefined) call.write(body);
    call.end();
  });
}

const MAX_RATE_LIMIT_DELAY_MS = 2 * 60 * 1000;

function isExchangeInProgress(response) {
  if (response.status !== 503) return false;
  try {
    return JSON.parse(response.body).message === "exchange is already in progress";
  } catch {
    return false;
  }
}

function requiresFreshAssertion(response) {
  try {
    const message = JSON.parse(response.body).message;
    return (
      isExchangeInProgress(response) ||
      (response.status === 502 &&
        message === "Socket API token creation timed out")
    );
  } catch {
    return false;
  }
}

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

// A pending reservation can represent a hung upstream create that never
// reaches the server's cleanup path. Do not keep a job coupled to it: obtain a
// fresh GitHub assertion immediately so the next attempt has a distinct replay
// key. Other HTTP failures retain the normal bounded retry policy.
async function retryExchangeInProgress(operation) {
  const response = await operation();
  if (!requiresFreshAssertion(response)) return response;
  const error = new Error(
    isExchangeInProgress(response)
      ? "Exchange is already in progress"
      : "Socket API token creation timed out",
  );
  error.code = "ESTS_FRESH_ASSERTION_REQUIRED";
  throw error;
}

async function retry(operation, options = {}) {
  const retryHttpResponses = options.retryHttpResponses !== false;
  const shouldRetryResponse = options.shouldRetryResponse ||
    ((response) => response.status < 200 || response.status >= 300);
  const shouldRetryError = options.shouldRetryError || (() => true);
  const sleep =
    options.sleep ||
    ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await operation();
      if (
        !retryHttpResponses ||
        !shouldRetryResponse(last) ||
        attempt === attempts - 1
      ) {
        return last;
      }
    } catch (error) {
      if (attempt === attempts - 1 || !shouldRetryError(error)) throw error;
    }
    await sleep(2 ** attempt * 1000);
  }
  return last;
}

function host(value) {
  if (
    typeof value === "string" &&
    value.length <= 253 &&
    value
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  ) {
    return value;
  }
  throw new Error("host must be a hostname without a scheme, port, or path");
}

module.exports = {
  MAX_RATE_LIMIT_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  host,
  isExchangeInProgress,
  requiresFreshAssertion,
  rateLimitDelay,
  request,
  retry,
  retryExchangeInProgress,
  retryRateLimited,
};
