const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const MAX_RETRY_MS = 90_000;

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
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = now() + maxElapsedMs;
  for (let retryCount = 0; ; retryCount += 1) {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new Error(`${label || "Request"} retry deadline exceeded`);
    let result;
    try {
      result = await operation(Math.min(10_000, remaining));
    } catch (error) {
      if (retryCount >= maxRetries) throw error;
    }
    if (result && (!isTransient(result) || retryCount >= maxRetries))
      return result;
    const backoff = initialDelayMs * 2 ** retryCount;
    const requested =
      result?.status === 429 ? retryAfterMs(result, now()) : null;
    const waitMs = Math.max(backoff, requested ?? 0);
    if (waitMs >= deadline - now()) {
      throw new Error(
        `${label || "Request"} retry delay exceeds the 90 second retry budget`,
      );
    }
    console.log(
      `Transient ${label || "request"} failure; retrying in ${waitMs}ms (retry ${retryCount + 1}/${maxRetries}).`,
    );
    await sleep(waitMs);
  }
}

module.exports = { isTransientStatus, retry, retryAfterMs };
