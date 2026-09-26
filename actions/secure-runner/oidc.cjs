const {
  RETRY_BUDGET_MS,
  request: httpRequest,
  retry,
} = require("../step-security-sts/http.cjs");

function oidcAvailable(env = process.env) {
  return ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"].every(
    (name) => /^\S+$/.test(env[name] || ""),
  );
}

// Milliseconds at which the assertion expires, or 0 when that cannot be read.
// Parsing is for freshness only; every STS verifies the signature itself.
function expiresAt(jwt) {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return Number.isSafeInteger(claims.exp) && claims.exp > 0 ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// One GitHub OIDC client for every exchange in a job. Each audience gets its
// own assertion, because GitHub issues one audience per token and each STS
// verifies its own, but concurrent callers share one request per audience and
// a still-valid assertion is reused. `fresh: true` bypasses the cache for an
// STS that consumed the previous assertion and needs a new one.
function createOidcClient({
  env = process.env,
  request = httpRequest,
  sleep,
  now = Date.now,
  random,
  budgetMs = RETRY_BUDGET_MS,
} = {}) {
  const cache = new Map();

  async function fetchAssertion(audience) {
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "";
    const rawUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL || "";
    if (!/^\S+$/.test(requestToken) || !/^\S+$/.test(rawUrl)) {
      throw new Error(
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing: the job must grant `id-token: write`",
      );
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") throw new Error("GitHub OIDC URL is invalid");
    url.searchParams.set("audience", audience);
    const deadline = now() + budgetMs;
    let response;
    try {
      response = await retry(
        (timeoutMs) =>
          request(url, { headers: { authorization: `Bearer ${requestToken}` }, timeoutMs }),
        { sleep, now, random, deadline },
      );
    } catch (error) {
      throw new Error(`GitHub OIDC request failed: ${error.message}`, { cause: error });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub OIDC request failed (HTTP ${response.status})`);
    }
    let value;
    try {
      value = JSON.parse(response.body).value;
    } catch {}
    if (typeof value !== "string" || !/^\S+$/.test(value)) {
      throw new Error("GitHub OIDC response is invalid");
    }
    return value;
  }

  return {
    available: () => oidcAvailable(env),
    token(audience, { fresh = false } = {}) {
      if (typeof audience !== "string" || audience === "") {
        return Promise.reject(new Error("OIDC audience is required"));
      }
      const cached = cache.get(audience);
      // A pending request has no expiry yet and is shared; a settled one is
      // reused until shortly before it expires.
      if (!fresh && cached && cached.expires > now() + 30_000) return cached.value;
      const entry = { value: fetchAssertion(audience), expires: Infinity };
      cache.set(audience, entry);
      entry.value.then(
        (jwt) => {
          entry.expires = expiresAt(jwt) || now() + 60_000;
        },
        () => {
          if (cache.get(audience) === entry) cache.delete(audience);
        },
      );
      return entry.value;
    },
  };
}

module.exports = { createOidcClient, expiresAt, oidcAvailable };
