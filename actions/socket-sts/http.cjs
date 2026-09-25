const https = require("node:https");

const REQUEST_TIMEOUT_MS = 10 * 1000;
const RETRY_ATTEMPTS = 4;
// One budget covers a whole credential exchange: OIDC and STS requests, their
// retries, assertion refreshes, and rate-limit waits. It matches the GitHub STS
// default, so every STS a job depends on gives up, and lets the caller degrade,
// at the same pace.
const RETRY_BUDGET_MS = 90_000;
// Backoff grows by up to a quarter at random, so a matrix of jobs that failed
// together retries spread out instead of hitting the STS in lockstep.
const JITTER_RATIO = 0.25;

const defaultSleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function jittered(delay, random = Math.random) {
  return Math.round(delay * (1 + JITTER_RATIO * random()));
}

function request(url, options = {}, body) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    let timeout;
    const clearRequestTimeout = () => clearTimeout(timeout);
    const call = https.request(url, requestOptions, (response) => {
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
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      call.destroy(error);
    }, timeoutMs);
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

function isProviderRateLimited(response) {
  if (response.status !== 429) return false;
  try {
    return JSON.parse(response.body).message === "Socket API rate limit exceeded";
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

// Waits out 429 responses for at most `maxDelay` in total. A server-specified
// delay is honored as given; the fallback backoff is jittered.
async function retryRateLimited(operation, options = {}) {
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const maxDelay = options.maxDelay ?? MAX_RATE_LIMIT_DELAY_MS;
  const deadline = now() + maxDelay;
  let attempt = 0;

  for (;;) {
    const response = await operation();
    if (response.status !== 429) return response;

    const requestedDelay = rateLimitDelay(response, now());
    const remaining = deadline - now();
    if (remaining < 100) {
      throw new Error("Rate limit retries exhausted the retry budget");
    }
    if (requestedDelay !== null && requestedDelay > remaining) {
      throw new Error(
        `Rate limit retry delay (${Math.ceil(requestedDelay / 1000)}s) exceeds the remaining retry budget (${Math.ceil(remaining / 1000)}s)`,
      );
    }
    const delay = Math.max(
      100,
      requestedDelay ??
        Math.min(jittered(1000 * 2 ** Math.min(attempt, 5), random), 30_000, remaining),
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

// Retries failures with jittered exponential backoff, never past `deadline`.
// The operation receives the request timeout to use: the smaller of the
// per-request timeout and what is left of the budget, so a stalled connection
// cannot outlive the budget either. When the budget runs out after a retryable
// response, that response is returned so the caller can report its status;
// after a transport failure, that failure is thrown.
async function retry(operation, options = {}) {
  const retryHttpResponses = options.retryHttpResponses !== false;
  const shouldRetryResponse = options.shouldRetryResponse ||
    ((response) => response.status < 200 || response.status >= 300);
  const shouldRetryError = options.shouldRetryError || (() => true);
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const deadline = options.deadline ?? Infinity;
  const attempts = options.attempts ?? RETRY_ATTEMPTS;
  let last;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      last = await operation(Math.min(REQUEST_TIMEOUT_MS, remaining));
      lastError = undefined;
      if (!retryHttpResponses || !shouldRetryResponse(last)) return last;
    } catch (error) {
      if (!shouldRetryError(error)) throw error;
      last = undefined;
      lastError = error;
    }
    if (attempt === attempts - 1) break;
    const delay = jittered(1000 * 2 ** attempt, random);
    if (delay >= deadline - now()) break;
    await sleep(delay);
  }
  if (lastError !== undefined) throw lastError;
  if (last !== undefined) return last;
  throw new Error("Retry budget exhausted before a request could be made");
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
  JITTER_RATIO,
  MAX_RATE_LIMIT_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_BUDGET_MS,
  host,
  jittered,
  isExchangeInProgress,
  isProviderRateLimited,
  requiresFreshAssertion,
  rateLimitDelay,
  request,
  retry,
  retryExchangeInProgress,
  retryRateLimited,
};
