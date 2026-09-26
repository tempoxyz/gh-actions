const fs = require("node:fs");
const {
  MAX_RATE_LIMIT_DELAY_MS,
  RETRY_BUDGET_MS,
  endpoint,
  isTransientStatus,
  request: httpRequest,
  retry,
  retryRateLimited,
} = require("./http.cjs");
const { disabledWarning, isServiceDisabled, requireServiceEnabled } = require("./status.cjs");

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

// Rate-limit waits and transient retries share one deadline, so the whole
// exchange stays inside the budget however the failures are mixed.
function retryExchange(operation, options = {}) {
  const now = options.now || Date.now;
  const deadline = options.deadline ?? Infinity;
  return retryRateLimited(
    () => retry(operation, {
      // The outer handler honors Retry-After for rate limits.
      shouldRetryResponse: (response) =>
        response.status !== 429 && isTransientStatus(response.status),
      sleep: options.sleep,
      now,
      random: options.random,
      deadline,
    }),
    {
      sleep: options.sleep,
      now,
      random: options.random,
      maxDelay: Math.min(MAX_RATE_LIMIT_DELAY_MS, deadline - now()),
    },
  );
}

function parseJson(body) {
  try {
    const value = JSON.parse(body);
    if (value !== null && typeof value === "object") return value;
  } catch {}
  return {};
}

// Fetches a GitHub OIDC assertion for `audience` from the runner's issuer.
async function githubAssertion(audience, { env, request, sleep, now, random, deadline }) {
  const oidcRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN", env);
  const rawOidcUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL", env);
  const oidcUrl = new URL(rawOidcUrl);
  if (oidcUrl.protocol !== "https:")
    throw new Error("GitHub OIDC URL is invalid");
  oidcUrl.searchParams.set("audience", audience);

  let oidcResponse;
  try {
    oidcResponse = await retry(
      (timeoutMs) =>
        request(oidcUrl, {
          headers: { authorization: `Bearer ${oidcRequestToken}` },
          timeoutMs,
        }),
      { sleep, now, random, deadline },
    );
  } catch (error) {
    throw new Error(`GitHub OIDC request failed: ${error.message}`, {
      cause: error,
    });
  }
  if (oidcResponse.status < 200 || oidcResponse.status >= 300) {
    throw new Error(`GitHub OIDC request failed (HTTP ${oidcResponse.status})`);
  }
  return parseJson(oidcResponse.body).value;
}

// Every failure surfaces as an Error whose message names the leg that failed
// and either the HTTP status or the transport cause, so callers that degrade
// instead of failing can report exactly why no credential was obtained.
// `getOidc(audience)` lets a caller that already holds an OIDC client, such as
// Secure Runner, supply the assertion instead of this action fetching its own.
async function exchangeToken(
  rawHost,
  {
    env = process.env,
    request = httpRequest,
    sleep,
    now = Date.now,
    random,
    budgetMs = RETRY_BUDGET_MS,
    getOidc,
    checkStatus = requireServiceEnabled,
  } = {},
) {
  const deadline = now() + budgetMs;
  const host = rawHost === undefined ? required("INPUT_HOST", env) : rawHost;
  const sts = endpoint(host);
  // A paused STS says so up front. That fails here with its reason instead of
  // retrying against its rejections for the rest of the budget.
  await checkStatus(sts.audience, { request, now, deadline });
  const oidc = getOidc
    ? await getOidc(sts.audience)
    : await githubAssertion(sts.audience, { env, request, sleep, now, random, deadline });
  if (typeof oidc !== "string" || !/^\S+$/.test(oidc)) {
    throw new Error("GitHub OIDC response is invalid");
  }

  // The STS makes exact OIDC assertion replays idempotent, so retrying a
  // transient response recovers the same lease instead of issuing another one.
  let exchange;
  try {
    exchange = await retryExchange(
      (timeoutMs) =>
        request(`${sts.origin}/sts/exchange`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${oidc}`,
            "content-length": "0",
            "user-agent": "tempoxyz-step-security-sts-action",
          },
          timeoutMs,
        }),
      { sleep, now, random, deadline },
    );
  } catch (error) {
    throw new Error(`Step Security STS exchange failed: ${error.message}`, {
      cause: error,
    });
  }
  const result = parseJson(exchange.body);
  if (exchange.status < 200 || exchange.status >= 300) {
    const message =
      typeof result.message === "string"
        ? `: ${result.message.replace(/[\r\n]+/g, " ").slice(0, 500)}`
        : "";
    throw new Error(
      `Step Security STS exchange failed (HTTP ${exchange.status})${message}`,
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
    throw new Error("Step Security STS response is invalid");
  }
  return {
    token: result.token,
    expiresAt: result.expires_at,
    leaseId: result.lease_id,
    rawHost: host,
  };
}

async function main({ env = process.env, exchange = exchangeToken } = {}) {
  let result;
  try {
    result = await exchange(undefined, { env });
  } catch (error) {
    // The standalone action has no fallback: the job needs the credential. The
    // annotation says why none was issued before the step fails.
    if (isServiceDisabled(error)) {
      disabledWarning(error, "No policy-store credential was issued to this job.", env);
    }
    throw error;
  }
  publishToken(result.token, result.expiresAt, result.leaseId);
  append(required("GITHUB_STATE", env), "sts_host", result.rawHost);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  append,
  exchangeToken,
  main,
  maskSecret,
  publishToken,
  required,
  retryExchange,
};
