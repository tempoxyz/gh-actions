const fs = require("node:fs");
const { endpoint, request, retry } = require("./http.cjs");

function required(name) {
  const value = process.env[name] || "";
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

async function exchangeToken(rawEndpoint = required("INPUT_STS-URL")) {
  maskSecret(rawEndpoint);
  const sts = endpoint(rawEndpoint);
  const oidcRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const rawOidcUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL");
  const oidcUrl = new URL(rawOidcUrl);
  if (oidcUrl.protocol !== "https:")
    throw new Error("GitHub OIDC URL is invalid");
  oidcUrl.searchParams.set("audience", sts.audience);

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

  // The STS makes exact OIDC assertion replays idempotent, so retrying a
  // transient response recovers the same lease instead of issuing another one.
  const exchange = await retry(() =>
    request(`${sts.origin}/sts/exchange`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${oidc}`,
        "content-length": "0",
        "user-agent": "tempoxyz-step-security-sts-action",
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
    rawEndpoint,
  };
}

async function main() {
  const result = await exchangeToken();
  publishToken(result.token, result.expiresAt, result.leaseId);
  append(required("GITHUB_STATE"), "sts_url", result.rawEndpoint);
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
};
