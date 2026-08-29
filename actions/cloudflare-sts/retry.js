const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry(operation, {
  label,
  isTransient = () => false,
  maxRetries = MAX_RETRIES,
  initialDelayMs = INITIAL_DELAY_MS,
  sleep = delay,
} = {}) {
  for (let retryCount = 0; ; retryCount += 1) {
    try {
      const result = await operation();
      if (!isTransient(result) || retryCount >= maxRetries) return result;

      const waitMs = initialDelayMs * 2 ** retryCount;
      console.log(`Transient ${label || "request"} failure; retrying in ${waitMs}ms (retry ${retryCount + 1}/${maxRetries}).`);
      await sleep(waitMs);
    } catch (error) {
      if (retryCount >= maxRetries) throw error;

      const waitMs = initialDelayMs * 2 ** retryCount;
      console.log(`Transient ${label || "request"} error; retrying in ${waitMs}ms (retry ${retryCount + 1}/${maxRetries}).`);
      await sleep(waitMs);
    }
  }
}

module.exports = { isTransientStatus, retry };
