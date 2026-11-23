const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const MAX_RETRY_MS = 90_000;
// Cloudflare's API allows each user 1,200 requests per five minutes, and the
// STS passes on its 429. A CI run that mints tokens for a hundred jobs at once
// can exceed that, and a 90-second budget gives up while the window is still
// full. So once a request is rate limited, the sequence gets a budget that
// outlasts the window, with jittered waits so the jobs don't retry in step.
const RATE_LIMIT_MAX_RETRIES = 15;
const RATE_LIMIT_RETRY_MS = 360_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

function isTransientStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status < 600)
  );
}

function retryAfterMs(response, now) {
  const header = response.headers?.["retry-after"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : Infinity;
  }
  // Do not let permissive date parsing reinterpret malformed numeric values.
  if (!/^[A-Za-z]{3},? /.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

async function retry(
  operation,
  {
    label,
    isTransient = () => false,
    maxRetries = MAX_RETRIES,
    initialDelayMs = INITIAL_DELAY_MS,
    maxElapsedMs = MAX_RETRY_MS,
    rateLimitMaxRetries = RATE_LIMIT_MAX_RETRIES,
    rateLimitElapsedMs = RATE_LIMIT_RETRY_MS,
    rateLimitMaxWaitMs = RATE_LIMIT_MAX_WAIT_MS,
    requestTimeoutMs = 10_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {},
) {
  const start = now();
  // A 429 switches the rest of the sequence to the rate-limit budget, so a
  // 5xx or network error while waiting out the window doesn't end it early.
  let rateLimited = false;
  const budgetMs = () =>
    rateLimited ? Math.max(maxElapsedMs, rateLimitElapsedMs) : maxElapsedMs;
  const retryLimit = () =>
    rateLimited ? Math.max(maxRetries, rateLimitMaxRetries) : maxRetries;
  for (let retryCount = 0; ; retryCount += 1) {
    const remaining = start + budgetMs() - now();
    if (remaining <= 0)
      throw new Error(`${label || "Request"} retry deadline exceeded`);
    let result;
    try {
      result = await operation(Math.min(requestTimeoutMs, remaining));
    } catch (error) {
      if (retryCount >= retryLimit()) throw error;
    }
    if (result?.status === 429) rateLimited = true;
    if (result && (!isTransient(result) || retryCount >= retryLimit()))
      return result;
    const backoff = initialDelayMs * 2 ** retryCount;
    let waitMs = backoff;
    if (rateLimited) {
      // Equal jitter: between half and all of the capped backoff.
      const capped = Math.min(backoff, rateLimitMaxWaitMs);
      waitMs = Math.round(capped / 2 + random() * (capped / 2));
    }
    if (result?.status === 429) {
      waitMs = Math.max(waitMs, retryAfterMs(result, now()) ?? 0);
    }
    if (waitMs >= start + budgetMs() - now()) {
      throw new Error(
        `${label || "Request"} retry delay exceeds the ${budgetMs() / 1000} second retry budget`,
      );
    }
    console.log(
      `${result?.status === 429 ? "Rate-limited" : "Transient"} ${label || "request"} failure; retrying in ${waitMs}ms (retry ${retryCount + 1}/${retryLimit()}).`,
    );
    await sleep(waitMs);
  }
}

module.exports = { isTransientStatus, retry, retryAfterMs };
