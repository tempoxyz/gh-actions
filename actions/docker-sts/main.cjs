const { appendFileSync } = require("node:fs");
const { request } = require("../cloudflare-sts/http.cjs");

const host = "dkr-sts.tempoxyz.org";

function parseResponse(response, label) {
  if (response.status !== 200) {
    throw new Error(`${label} failed (HTTP ${response.status})`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function exchange(env = process.env, send = request, log = console.log) {
  const policy = env.DOCKER_STS_POLICY || "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(policy)) {
    throw new Error(
      "policy must be a Docker STS policy name (lowercase letters, digits, underscores, or hyphens)",
    );
  }

  const ttl = env.DOCKER_STS_TTL || "15m";
  const minutes = Number(/^(\d{1,3})m$/.exec(ttl)?.[1]);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) {
    throw new Error("ttl must be between 5m and 60m");
  }

  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "";
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!/^\S+$/.test(requestToken) || !requestUrl) {
    throw new Error("The job needs id-token: write to request a GitHub OIDC token");
  }
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is unavailable");

  let oidcUrl;
  try {
    oidcUrl = new URL(requestUrl);
  } catch {
    throw new Error("GitHub OIDC request URL is invalid");
  }
  if (oidcUrl.protocol !== "https:" || oidcUrl.username || oidcUrl.password) {
    throw new Error("GitHub OIDC request URL is invalid");
  }
  oidcUrl.searchParams.set("audience", host);
  const oidcResponse = await send(oidcUrl, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  const oidc = parseResponse(oidcResponse, "GitHub OIDC request")?.value;
  if (
    typeof oidc !== "string" ||
    oidc.length > 16 * 1024 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(oidc)
  ) {
    throw new Error("GitHub OIDC response did not contain a valid token");
  }
  log(`::add-mask::${oidc}`);

  const exchangeUrl = new URL(`https://${host}/sts/exchange`);
  exchangeUrl.searchParams.set("identity", policy);
  exchangeUrl.searchParams.set("ttl", ttl);
  // A failed response can follow a successful mint, so send the exchange once.
  const response = await send(exchangeUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${oidc}` },
    timeoutMs: 60_000,
  });
  const token = parseResponse(response, "Docker STS exchange")?.token;
  if (typeof token !== "string" || !/^dckr_oat_[A-Za-z0-9_-]{1,1024}$/.test(token)) {
    throw new Error("Docker STS response did not contain a valid Docker Hub token");
  }
  log(`::add-mask::${token}`);
  appendFileSync(env.GITHUB_OUTPUT, `token=${token}\n`);
}

if (require.main === module) {
  exchange().catch((error) => {
    console.error(`::error title=Docker STS::${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { exchange };
