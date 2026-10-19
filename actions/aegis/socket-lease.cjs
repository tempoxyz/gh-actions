const { createOidcClient } = require("../secure-runner/oidc.cjs");
const { exchange: exchangeSocket } = require("../socket-sts/main.cjs");
const { host, request, retry, RETRY_BUDGET_MS } = require("../socket-sts/http.cjs");

const RENEW_BEFORE_MS = 5 * 60_000;
const RETRY_AFTER_MS = 30_000;
const validToken = (token) => typeof token === "string" && /^\S{20,4096}$/.test(token);

// Keep Socket leases separate from Aegis's reusable GitHub identity assertions.
// Every exchange needs a fresh, single-use assertion for the STS's audience.
function createSocketLease({ token, expiresAt, endpoint, oidc }, {
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  exchange = exchangeSocket, createOidc = createOidcClient,
  revoke = async (token) => {
    const body = JSON.stringify({ token });
    await retry((timeoutMs) => request(`https://${endpoint}/sts/exchange`, {
      method: "DELETE", timeoutMs,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        "user-agent": "tempoxyz-socket-sts-action" },
    }, body), { deadline: now() + 10_000, now });
  },
} = {}) {
  host(endpoint);
  let expires = Date.parse(expiresAt);
  if (!validToken(token) || !Number.isFinite(expires)) throw new Error("Invalid Socket lease");
  let renewAt = expires - Math.min(RENEW_BEFORE_MS, Math.max(0, expires - now()) / 2);
  let retryAt = 0, timer, loading, closed = false;
  const tokens = new Map([[token, expires]]);
  const source = { ACTIONS_ID_TOKEN_REQUEST_URL: oidc?.requestURL || "",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc?.requestToken || "" };

  function schedule() {
    if (closed) return;
    clearTimer(timer);
    timer = setTimer(renew, Math.max(0, Math.max(renewAt, retryAt) - now()));
    timer.unref?.();
  }

  async function discard(token) {
    // Cleanup may race a mint already accepted by the STS. Revoke its result
    // here instead of publishing it after the post hook collected the leases.
    try { await revoke(token); } catch { /* The STS still enforces expiry. */ }
  }

  function renew() {
    if (closed || loading) return loading;
    loading = Promise.resolve().then(async () => {
      const deadline = now() + RETRY_BUDGET_MS;
      try {
        const result = await exchange({ endpoint, now, deadline,
          getAssertion: () => createOidc({ env: source, now,
            budgetMs: Math.max(0, deadline - now()) }).token(endpoint, { fresh: true }),
        });
        const replacementExpiry = Date.parse(result?.expiresAt);
        if (!validToken(result?.token)) return;
        if (closed || !Number.isFinite(replacementExpiry) || replacementExpiry <= now() ||
            result.token === token || replacementExpiry <= expires) {
          // A repeated value must not revoke a lease already handed to Aegis.
          if (!tokens.has(result.token)) await discard(result.token);
          return;
        }
        token = result.token;
        expires = replacementExpiry;
        tokens.set(token, expires);
        for (const [value, expiry] of tokens) if (expiry <= now()) tokens.delete(value);
        renewAt = expires - Math.min(RENEW_BEFORE_MS, (expires - now()) / 2);
      } catch {
        // Do not expose STS response bodies, OIDC assertions, or credentials.
        // Retain a still-valid lease and retry independently of package scans.
      } finally {
        retryAt = now() + RETRY_AFTER_MS;
        loading = undefined;
        schedule();
      }
    });
    return loading;
  }

  schedule();
  return {
    value() { return !closed && now() < expires ? token : ""; },
    close() {
      closed = true;
      clearTimer(timer);
      return [...tokens].filter(([, expiry]) => now() < expiry).map(([value]) => value);
    },
  };
}

module.exports = { createSocketLease, RENEW_BEFORE_MS, RETRY_AFTER_MS };
