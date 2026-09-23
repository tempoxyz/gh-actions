const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

class RetryTimeoutError extends Error {}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Only reset an hourly budget when GitHub says that budget is exhausted.
function retryAfterMs(response, now = Date.now()) {
  const headers = response?.headers || {};
  const delays = [];
  const value = headers["retry-after"];
  if (typeof value === "string") {
    const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) delays.push(milliseconds);
  }
  const reset = headers["x-ratelimit-reset"];
  if (headers["x-ratelimit-remaining"] === "0" && typeof reset === "string" && /^\d+$/.test(reset)) {
    const milliseconds = Number(reset) * 1000 - now;
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) delays.push(milliseconds);
  }
  if (delays.length) return Math.max(...delays);
  return response?.status === 429 ? 60_000 : 0;
}

async function retry(operation, {
  label,
  isTransient = () => false,
  maxRetries = MAX_RETRIES,
  initialDelayMs = INITIAL_DELAY_MS,
  sleep = delay,
  deadlineMs = Infinity,
  now = Date.now,
  getDelayMs = () => 0,
} = {}) {
  for (let retryCount = 0; ; retryCount += 1) {
    if (now() >= deadlineMs) throw new RetryTimeoutError(`${label || "Request"} retry timeout exceeded.`);
    let result;
    let requestError;
    try {
      result = await operation();
    } catch (error) {
      if (error instanceof RetryTimeoutError || retryCount >= maxRetries) throw error;
      requestError = error;
    }
    if (!requestError && (!isTransient(result) || retryCount >= maxRetries)) return result;
    const waitMs = Math.max(initialDelayMs * 2 ** retryCount, requestError ? 0 : getDelayMs(result));
    if (now() + waitMs >= deadlineMs) {
      const date = new Date(now() + waitMs);
      const retryAt = Number.isNaN(date.getTime()) ? "beyond the supported date range" : date.toISOString();
      throw new RetryTimeoutError(`${label || "Request"} retry timeout exceeded; next retry permitted at ${retryAt}.`);
    }
    console.log(`Transient ${label || "request"} failure; retrying in ${waitMs}ms (retry ${retryCount + 1}/${maxRetries}).`);
    await sleep(waitMs);
  }
}

module.exports = { isTransientStatus, retry, retryAfterMs };
