const fs = require("node:fs");
const {
  endpoint,
  isTransientStatus,
  request: httpRequest,
  retry,
  retryRateLimited,
} = require("./http.cjs");

// Raised when no credential could be obtained for reasons outside the caller's
// control: a transport failure or timeout, a transient response (408, 425,
// 429, or 5xx) that persisted through every retry, an exhausted rate-limit
// budget, or a malformed success response. Definitive rejections such as 401,
// 403, or 404 stay plain Errors: they mean the request itself is wrong, and a
// silent fallback would hide that misconfiguration.
class StsUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "StsUnavailableError";
  }
}

function required(name, env = process.env) {
  const value = env[name] || "";
  if (!/^\S+$/.test(value)) throw new Error(`${name} is missing`);
  return value;
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

function publishToken(token, expiresAt, leaseId) {
  maskSecret(token);
  append(required("GITHUB_OUTPUT"), "token", token);
  append(required("GITHUB_OUTPUT"), "expires-at", expiresAt);
  append(required("GITHUB_STATE"), "token", token);
  append(required("GITHUB_STATE"), "lease_id", leaseId);
}

function retryExchange(operation, options = {}) {
  return retryRateLimited(
    () => retry(operation, {
      // The outer handler honors Retry-After for rate limits.
      shouldRetryResponse: (response) =>
        response.status !== 429 && isTransientStatus(response.status),
      sleep: options.sleep,
    }),
    options,
  );
}

// A transient status that survived every retry is an availability failure; any
// other non-success status is a definitive rejection.
function failedRequest(message, status) {
  return isTransientStatus(status)
    ? new StsUnavailableError(message)
    : new Error(message);
}

function parseJson(body) {
  try {
    const value = JSON.parse(body);
    if (value !== null && typeof value === "object") return value;
  } catch {}
  return {};
}

async function exchangeToken(
  rawHost,
  { env = process.env, request = httpRequest, sleep, now } = {},
) {
  const host = rawHost === undefined ? required("INPUT_HOST", env) : rawHost;
  const sts = endpoint(host);
  const oidcRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN", env);
  const rawOidcUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL", env);
  const oidcUrl = new URL(rawOidcUrl);
  if (oidcUrl.protocol !== "https:")
    throw new Error("GitHub OIDC URL is invalid");
  oidcUrl.searchParams.set("audience", sts.audience);

  let oidcResponse;
  try {
    oidcResponse = await retry(
      () =>
        request(oidcUrl, {
          headers: { authorization: `Bearer ${oidcRequestToken}` },
        }),
      { sleep },
    );
  } catch (error) {
    throw new StsUnavailableError(
      `GitHub OIDC request failed: ${error.message}`,
      { cause: error },
    );
  }
  if (oidcResponse.status < 200 || oidcResponse.status >= 300) {
    throw failedRequest(
      `GitHub OIDC request failed (HTTP ${oidcResponse.status})`,
      oidcResponse.status,
    );
  }
  const oidc = parseJson(oidcResponse.body).value;
  if (typeof oidc !== "string" || !/^\S+$/.test(oidc)) {
    throw new StsUnavailableError("GitHub OIDC response is invalid");
  }

  // The STS makes exact OIDC assertion replays idempotent, so retrying a
  // transient response recovers the same lease instead of issuing another one.
  let exchange;
  try {
    exchange = await retryExchange(
      () =>
        request(`${sts.origin}/sts/exchange`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${oidc}`,
            "content-length": "0",
            "user-agent": "tempoxyz-step-security-sts-action",
          },
        }),
      { sleep, now },
    );
  } catch (error) {
    throw new StsUnavailableError(
      `Step Security STS exchange failed: ${error.message}`,
      { cause: error },
    );
  }
  const result = parseJson(exchange.body);
  if (exchange.status < 200 || exchange.status >= 300) {
    const message =
      typeof result.message === "string"
        ? `: ${result.message.replace(/[\r\n]+/g, " ").slice(0, 500)}`
        : "";
    throw failedRequest(
      `Step Security STS exchange failed (HTTP ${exchange.status})${message}`,
      exchange.status,
    );
  }
  if (
    typeof result.token !== "string" ||
    !/^\S{20,4096}$/.test(result.token) ||
    typeof result.expires_at !== "string" ||
    !Number.isFinite(Date.parse(result.expires_at)) ||
    typeof result.lease_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      result.lease_id,
    )
  ) {
    throw new StsUnavailableError("Step Security STS response is invalid");
  }
  return {
    token: result.token,
    expiresAt: result.expires_at,
    leaseId: result.lease_id,
    rawHost: host,
  };
}

async function main() {
  const result = await exchangeToken();
  publishToken(result.token, result.expiresAt, result.leaseId);
  append(required("GITHUB_STATE"), "sts_host", result.rawHost);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  StsUnavailableError,
  append,
  exchangeToken,
  main,
  maskSecret,
  publishToken,
  required,
  retryExchange,
};
