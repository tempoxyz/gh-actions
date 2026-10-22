const { brokerFailureDetail } = require("./error.cjs");

const BASE_RETRY_DELAY_MS = 1_000;
const MAX_TOTAL_RETRY_DELAY_MS = 60_000;
const OPERATION_POLL_INTERVAL_MS = 10_000;
const OPERATION_POLL_TIMEOUT_MS = 11 * 60_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseResponseBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return {};
  }
}

function isTransientStatus(status) {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

function retryAfterMilliseconds(value, now) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const normalized = value.trim();
  if (/^[0-9]+$/.test(normalized)) {
    const seconds = Number(normalized);
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : Infinity;
  }
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

function nextRetryDelay(transientAttempt, retryAfter, now) {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** (transientAttempt - 1);
  const retryAfterDelay = retryAfterMilliseconds(retryAfter, now);
  return retryAfterDelay !== undefined && retryAfterDelay >= exponential
    ? { delayMs: retryAfterDelay, usedRetryAfter: true }
    : { delayMs: exponential, usedRetryAfter: false };
}

function retryLimitError(
  message,
  delayMs,
  totalDelayMs,
  retryAfter,
  usedRetryAfter,
) {
  const source =
    usedRetryAfter && retryAfter !== undefined
      ? `Retry-After ${JSON.stringify(retryAfter)}`
      : "exponential backoff";
  return new Error(
    `${message}: ${source} requires ${Math.ceil(delayMs / 1_000)} seconds, which would make total transient retry delay exceed 60 seconds (already delayed ${Math.ceil(totalDelayMs / 1_000)} seconds)`,
  );
}

async function requestDeployment(attempt, dependencies = {}) {
  const wait = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const pollIntervalMs =
    dependencies.operationPollIntervalMs ?? OPERATION_POLL_INTERVAL_MS;
  const pollTimeoutMs =
    dependencies.operationPollTimeoutMs ?? OPERATION_POLL_TIMEOUT_MS;
  let operationPollStartedAt;
  let consecutiveTransientAttempts = 0;
  let totalTransientDelayMs = 0;

  async function retry(retryAfter, message) {
    consecutiveTransientAttempts += 1;
    const { delayMs, usedRetryAfter } = nextRetryDelay(
      consecutiveTransientAttempts,
      retryAfter,
      now(),
    );
    if (
      !Number.isFinite(delayMs) ||
      totalTransientDelayMs + delayMs > MAX_TOTAL_RETRY_DELAY_MS
    ) {
      throw retryLimitError(
        message,
        delayMs,
        totalTransientDelayMs,
        retryAfter,
        usedRetryAfter,
      );
    }
    totalTransientDelayMs += delayMs;
    console.log(
      `${message}; retrying in ${Math.ceil(delayMs / 1_000)} seconds (${Math.ceil(totalTransientDelayMs / 1_000)} of 60 seconds total retry delay)`,
    );
    await wait(delayMs);
  }

  while (true) {
    let response;
    try {
      response = await attempt();
    } catch (error) {
      if (
        error?.retryable === false ||
        (Number.isSafeInteger(error?.status) &&
          !isTransientStatus(error.status))
      ) {
        throw error;
      }
      await retry(
        error?.retryAfter,
        Number.isSafeInteger(error?.status)
          ? `Request returned transient HTTP ${error.status}`
          : "Request failed transiently",
      );
      continue;
    }

    const result = parseResponseBody(response);
    if (
      response.status === 409 &&
      result !== null &&
      typeof result === "object" &&
      result.error === "operation_in_progress"
    ) {
      consecutiveTransientAttempts = 0;
      operationPollStartedAt ??= now();
      const elapsedMs = now() - operationPollStartedAt;
      if (elapsedMs >= pollTimeoutMs) {
        throw new Error(
          "Timed out waiting for the in-progress Cloudflare Deploy Broker deployment",
        );
      }
      const delayMs = Math.min(pollIntervalMs, pollTimeoutMs - elapsedMs);
      console.log(
        `Cloudflare Deploy Broker deployment is still in progress; retrying in ${Math.ceil(delayMs / 1_000)} seconds`,
      );
      await wait(delayMs);
      continue;
    }

    if (isTransientStatus(response.status)) {
      await retry(
        response.retryAfter,
        `Cloudflare Deploy Broker returned transient HTTP ${response.status}${brokerFailureDetail(result)}`,
      );
      continue;
    }
    return { response, result };
  }
}

module.exports = { requestDeployment };
