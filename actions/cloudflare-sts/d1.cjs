const { request } = require("./http.cjs");
const { isTransientStatus, retryAfterMs } = require("./retry.cjs");

const HEALTH_CHECK_SQL = "SELECT 1 /* Cloudflare STS health check */";
const DATABASE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireD1Ready(
  { token, accountId, expiresAt },
  {
    request: sendRequest = request,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
  } = {},
) {
  const deadline = Math.min(now() + 30_000, Date.parse(expiresAt));
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`;
  let databaseId;
  let backoff = 250;
  const timeout = () => {
    const remaining = deadline - now();
    if (!(remaining > 0))
      throw new Error(
        "D1 readiness check exceeded its 30-second/token-expiry deadline",
      );
    return Math.min(10_000, remaining);
  };
  const send = async (url, body) => {
    const timeoutMs = timeout();
    let response;
    try {
      response = await sendRequest(
        new URL(url),
        {
          method: body === undefined ? "GET" : "POST",
          timeoutMs,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
        },
        body,
      );
    } catch {
      return { retry: true };
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      isTransientStatus(response.status)
    )
      return { retry: true, response };
    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error("D1 readiness check received an invalid response");
    }
    if (
      Array.isArray(data?.errors) &&
      data.errors.some((error) => error?.code === 10000)
    )
      return { retry: true, response };
    if (
      response.status < 200 ||
      response.status >= 300 ||
      data?.success !== true
    )
      throw new Error(`D1 readiness check failed (HTTP ${response.status})`);
    return { data };
  };

  for (;;) {
    timeout();
    let result;
    if (!databaseId) {
      result = await send(`${base}?per_page=10`);
      if (!result.retry) {
        const databases = result.data.result;
        if (!Array.isArray(databases))
          throw new Error(
            "D1 readiness check received an invalid database list",
          );
        if (databases.length === 0)
          throw new Error(
            "D1 readiness check cannot run: no D1 databases in the requested account",
          );
        databaseId = databases[0]?.uuid;
        if (typeof databaseId !== "string" || !DATABASE_ID.test(databaseId))
          throw new Error("D1 readiness check received an invalid database ID");
      }
    }
    if (databaseId) {
      result = await send(
        `${base}/${databaseId}/query`,
        JSON.stringify({ sql: HEALTH_CHECK_SQL }),
      );
      if (!result.retry) {
        timeout();
        if (
          !Array.isArray(result.data.result) ||
          result.data.result.length !== 1 ||
          result.data.result[0]?.success !== true
        )
          throw new Error(
            "D1 readiness check received an unsuccessful query result",
          );
        log("Cloudflare D1 token readiness check passed.");
        return;
      }
    }
    timeout();
    const requested =
      result.response?.status === 429
        ? retryAfterMs(result.response, now())
        : null;
    const remaining = deadline - now();
    if (requested !== null && requested >= remaining)
      throw new Error(
        "D1 readiness check Retry-After exceeds its remaining deadline",
      );
    const waitMs = Math.min(Math.max(backoff, requested ?? 0), remaining);
    log(`Cloudflare D1 token is not ready; retrying in ${waitMs}ms.`);
    await sleep(waitMs);
    backoff = Math.min(backoff * 2, 4_000);
  }
}

module.exports = { HEALTH_CHECK_SQL, requireD1Ready };
