const fs = require("node:fs");
const {
  RETRY_BUDGET_MS,
  host,
  isProviderRateLimited,
  request: httpRequest,
  retry,
  retryExchangeInProgress,
  retryRateLimited,
  requiresFreshAssertion,
} = require("./http.cjs");
const { disabledWarning, isServiceDisabled, requireServiceEnabled } = require("./status.cjs");

const ASSERTION_ATTEMPTS = 2;

function required(name) {
  const value = process.env[name] || "";
  if (!/^\S+$/.test(value)) throw new Error(`${name} is missing`);
  return value;
}

async function exchangeWithFreshAssertion(getAssertion, exchange) {
  let lastError;
  for (let attempt = 0; attempt < ASSERTION_ATTEMPTS; attempt += 1) {
    try {
      return await exchange(await getAssertion());
    } catch (error) {
      lastError = error;
      if (
        !["ESTS_FRESH_ASSERTION_REQUIRED", "ETIMEDOUT"].includes(error?.code) ||
        attempt === ASSERTION_ATTEMPTS - 1
      ) {
        throw error;
      }
      console.log(
        "Socket STS exchange needs a fresh assertion; retrying with a fresh GitHub OIDC assertion",
      );
    }
  }
  throw lastError;
}

// One deadline bounds every assertion attempt, transient retry, and
// rate-limit wait, so the whole exchange stays inside the budget however the
// failures are mixed. Each request is bounded by the remaining budget too.
function exchangeWithRetry(getAssertion, exchange, options = {}) {
  const now = options.now || Date.now;
  const deadline = options.deadline ?? now() + RETRY_BUDGET_MS;
  return exchangeWithFreshAssertion(getAssertion, (initialAssertion) => {
    let assertion = initialAssertion;
    let refresh = false;
    return retryRateLimited(async () => {
      // A provider rate limit consumes the assertion. Refresh only after the
      // retry delay; pending exchanges must keep polling their original claim.
      if (refresh) {
        assertion = await getAssertion();
        refresh = false;
      }
      const response = await retryExchangeInProgress(() =>
        retry((timeoutMs) => exchange(assertion, timeoutMs), {
          sleep: options.sleep,
          now,
          random: options.random,
          deadline,
          // Let the outer handlers pace 429s and refresh after definite mint
          // timeouts, legacy in-progress responses, or transport timeouts.
          shouldRetryResponse: (response) =>
            (response.status < 200 || response.status >= 300) &&
            response.status !== 429 && !requiresFreshAssertion(response),
          shouldRetryError: (error) => error?.code !== "ETIMEDOUT",
        }),
      );
      refresh = isProviderRateLimited(response);
      return response;
    }, {
      sleep: options.sleep,
      now,
      random: options.random,
      maxDelay: Math.max(0, deadline - now()),
    });
  });
}

// Exchanges GitHub OIDC assertions from `getAssertion` for a Socket API token
// at `endpoint`. `getAssertion` is called again whenever the STS consumed the
// previous assertion, so it must return a fresh one on repeat calls.
async function exchange({
  endpoint,
  getAssertion,
  request = httpRequest,
  now = Date.now,
  deadline = now() + RETRY_BUDGET_MS,
  sleep,
  random,
  checkStatus = requireServiceEnabled,
}) {
  // A paused STS says so up front. That fails here with its reason instead of
  // retrying against its rejections for the rest of the budget.
  await checkStatus(endpoint, { request, now, deadline });
  const response = await exchangeWithRetry(
    getAssertion,
    (oidc, timeoutMs) =>
      request(`https://${endpoint}/sts/exchange`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${oidc}`,
          "content-length": "0",
          "user-agent": "tempoxyz-socket-sts-action",
        },
        timeoutMs,
      }),
    { now, deadline, sleep, random },
  );
  let result = {};
  try {
    result = JSON.parse(response.body);
  } catch {}
  if (result === null || typeof result !== "object") result = {};
  if (response.status < 200 || response.status >= 300) {
    const message =
      typeof result.message === "string"
        ? `: ${result.message.replace(/[\r\n]+/g, " ").slice(0, 500)}`
        : "";
    throw new Error(
      `Socket STS exchange failed (HTTP ${response.status})${message}`,
    );
  }
  if (
    typeof result.token !== "string" ||
    !/^\S{20,4096}$/.test(result.token) ||
    typeof result.expires_at !== "string" ||
    !Number.isFinite(Date.parse(result.expires_at))
  ) {
    throw new Error("Socket STS response is invalid");
  }
  return { token: result.token, expiresAt: result.expires_at };
}

function append(file, name, value) {
  if (/\r|\n/.test(value)) throw new Error(`${name} contains a newline`);
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function maskSecret(value) {
  const escaped = value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.log(`::add-mask::${escaped}`);
}

function publishToken(token, expiresAt) {
  // Register the token before writing it anywhere GitHub may expose as output.
  maskSecret(token);
  append(required("GITHUB_OUTPUT"), "token", token);
  append(required("GITHUB_OUTPUT"), "expires-at", expiresAt);
  append(required("GITHUB_STATE"), "token", token);
  // Composite shell steps can reuse this runtime without installing Node or
  // assuming that the runner's bundled executable is available on PATH.
  append(required("GITHUB_OUTPUT"), "node-path", process.execPath);
}

async function main({ exchange: exchangeToken = exchange } = {}) {
  const uploadAegisReport = process.env["INPUT_UPLOAD-AEGIS-REPORT"] || "true";
  if (uploadAegisReport !== "true" && uploadAegisReport !== "false") {
    throw new Error("upload-aegis-report must be either true or false");
  }
  const endpoint = host(process.env.INPUT_HOST || "socket-sts.tempoxyz.net");
  const oidcRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const rawOidcUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL");
  const oidcUrl = new URL(rawOidcUrl);
  if (oidcUrl.protocol !== "https:")
    throw new Error("GitHub OIDC URL is invalid");
  oidcUrl.searchParams.set("audience", endpoint);
  const now = Date.now;
  const deadline = now() + RETRY_BUDGET_MS;

  const getAssertion = async () => {
    const oidcResponse = await retry(
      (timeoutMs) =>
        httpRequest(oidcUrl, {
          headers: { authorization: `Bearer ${oidcRequestToken}` },
          timeoutMs,
        }),
      { now, deadline },
    );
    if (oidcResponse.status < 200 || oidcResponse.status >= 300) {
      throw new Error(`GitHub OIDC request failed (HTTP ${oidcResponse.status})`);
    }
    const oidc = JSON.parse(oidcResponse.body).value;
    if (typeof oidc !== "string" || !/^\S+$/.test(oidc)) {
      throw new Error("GitHub OIDC response is invalid");
    }
    return oidc;
  };

  let result;
  try {
    result = await exchangeToken({ endpoint, getAssertion, now, deadline });
  } catch (error) {
    // The standalone action has no fallback: the job needs the token. The
    // annotation says why none was issued before the step fails.
    if (isServiceDisabled(error)) {
      disabledWarning(error, "No Socket API token was issued to this job.");
    }
    throw error;
  }
  publishToken(result.token, result.expiresAt);
  append(required("GITHUB_STATE"), "host", endpoint);
  append(required("GITHUB_STATE"), "upload_aegis_report", uploadAegisReport);
  append(required("GITHUB_STATE"), "action", process.env.GITHUB_ACTION || "socket-sts");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ASSERTION_ATTEMPTS,
  exchange,
  exchangeWithFreshAssertion,
  exchangeWithRetry,
  main,
  maskSecret,
  publishToken,
};
