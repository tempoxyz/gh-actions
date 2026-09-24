const fs = require("node:fs");
const {
  host,
  isProviderRateLimited,
  request,
  retry,
  retryExchangeInProgress,
  retryRateLimited,
  requiresFreshAssertion,
} = require("./http.cjs");

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

function exchangeWithRetry(getAssertion, exchange, options = {}) {
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
        retry(() => exchange(assertion), {
          sleep: options.sleep,
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
    }, options);
  });
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

async function main() {
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

  const getAssertion = async () => {
    const oidcResponse = await retry(() =>
      request(oidcUrl, {
        headers: { authorization: `Bearer ${oidcRequestToken}` },
      }),
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

  const exchange = await exchangeWithRetry(
    getAssertion,
    (oidc) =>
      request(`https://${endpoint}/sts/exchange`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${oidc}`,
          "content-length": "0",
          "user-agent": "tempoxyz-socket-sts-action",
        },
      }),
  );
  let result = {};
  try {
    result = JSON.parse(exchange.body);
  } catch {}
  if (exchange.status < 200 || exchange.status >= 300) {
    const message =
      typeof result.message === "string"
        ? `: ${result.message.replace(/[\r\n]+/g, " ").slice(0, 500)}`
        : "";
    throw new Error(
      `Socket STS exchange failed (HTTP ${exchange.status})${message}`,
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
  publishToken(result.token, result.expires_at);
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
  exchangeWithFreshAssertion,
  exchangeWithRetry,
  main,
  maskSecret,
  publishToken,
};
