const AUDIENCE = "https://aegis.tempoxyz.dev";
const TIMEOUT_MS = 1_500; // Leave room within the client's two-second deadline.
const MAX_RESPONSE_BYTES = 64 * 1024;

function runnerOIDCEnvironment(env = process.env) {
  return {
    requestURL: env.ACTIONS_ID_TOKEN_REQUEST_URL || "",
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "",
  };
}

// Parsing is for freshness/audience only, not signature verification. Identity
// consumers must cryptographically verify the JWT before trusting its claims.
function expiry(jwt) {
  if (typeof jwt !== "string" || jwt.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) return 0;
  try {
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= 0 || !audiences.every((value) => typeof value === "string") || !audiences.includes(AUDIENCE)) return 0;
    const milliseconds = claims.exp * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  } catch {
    return 0;
  }
}

function createGitHubOIDC({ requestURL, requestToken } = {}, { fetcher = fetch, now = Date.now } = {}) {
  let token = "";
  let expires = 0;
  let retryAt = 0;
  let loading;

  async function acquire() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      if (typeof requestURL !== "string" || typeof requestToken !== "string" || !requestToken || /\s/.test(requestToken)) return;
      const url = new URL(requestURL);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return;
      url.searchParams.set("audience", AUDIENCE);
      const response = await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) return;
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) return;
        chunks.push(Buffer.from(chunk));
      }
      const candidate = JSON.parse(Buffer.concat(chunks).toString("utf8")).value;
      const candidateExpiry = expiry(candidate);
      if (candidateExpiry > now()) {
        token = candidate;
        expires = candidateExpiry;
      }
    } catch {
      // Never log request credentials, endpoint URLs, response bodies, or JWTs.
      // Optional identity acquisition must not break Socket credential delivery.
    } finally {
      controller.abort();
      clearTimeout(timer);
      retryAt = now() + 60_000;
    }
  }

  return async function getToken(audience) {
    // The loopback provider is not a general-purpose OIDC minting endpoint.
    if (audience !== AUDIENCE) return "";
    if (now() >= expires - 30_000 && now() >= retryAt) {
      if (!loading) loading = acquire().finally(() => { loading = undefined; });
      await loading;
    }
    return now() < expires ? token : "";
  };
}

module.exports = { AUDIENCE, TIMEOUT_MS, runnerOIDCEnvironment, createGitHubOIDC };
