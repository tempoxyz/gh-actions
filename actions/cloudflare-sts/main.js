const fs = require("node:fs");
const https = require("node:https");
const { isTransientStatus, retry } = require("./retry.js");
const { parseTtl } = require("./ttl.js");

const MAX_RESPONSE_BYTES = 64 * 1024;

function input(name) {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replaceAll("-", "_")}`] || "";
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const outbound = https.request(url, options, (response) => {
      let body = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("response exceeded 64 KiB"));
          return;
        }
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", reject);
    });
    outbound.on("error", reject);
    outbound.end();
  });
}

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function main() {
  const dev = input("dev");
  const host = dev === "true" ? "cf-sts.tehq.dev" : dev === "false" ? "cf-sts.tehq.net" : null;
  if (!host) throw new Error("dev must be either true or false");

  const policy = input("policy");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(policy) || policy === "." || policy === "..") {
    throw new Error("policy must contain 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  const ttl = input("ttl") || "15m";
  parseTtl(ttl);

  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!oidcRequestToken) throw new Error("id-token: write permission is required");
  if (!oidcRequestUrl) throw new Error("GitHub OIDC request URL is unavailable");

  const oidcUrl = new URL(oidcRequestUrl);
  oidcUrl.searchParams.set("audience", host);
  const oidcResponse = await retry(
    () => request(oidcUrl, {
      headers: { Authorization: `Bearer ${oidcRequestToken}` },
    }),
    { label: "GitHub OIDC request", isTransient: (response) => isTransientStatus(response.status) },
  );
  if (oidcResponse.status < 200 || oidcResponse.status >= 300) {
    throw new Error(`GitHub OIDC request failed (HTTP ${oidcResponse.status})`);
  }
  const oidc = parseJson(oidcResponse.body).value;
  if (typeof oidc !== "string" || oidc.length === 0 || oidc.length > 16 * 1024 || /[\r\n]/.test(oidc)) {
    throw new Error("GitHub OIDC response did not contain a valid token");
  }

  const exchangeUrl = new URL(`https://${host}/sts/exchange`);
  exchangeUrl.searchParams.set("identity", policy);
  exchangeUrl.searchParams.set("ttl", ttl);
  const exchangeResponse = await retry(
    () => request(exchangeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${oidc}` },
    }),
    { label: "Cloudflare STS exchange", isTransient: (response) => isTransientStatus(response.status) },
  );

  const exchangeBody = parseJson(exchangeResponse.body);
  if (exchangeResponse.status < 200 || exchangeResponse.status >= 300) {
    const message = typeof exchangeBody.message === "string" ? `: ${exchangeBody.message.replace(/[\r\n]+/g, " ").slice(0, 500)}` : "";
    throw new Error(`Cloudflare STS exchange failed (HTTP ${exchangeResponse.status})${message}`);
  }

  const token = exchangeBody.token;
  const expiresAt = exchangeBody.expires_at;
  const accountId = exchangeBody.account_id;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 16 * 1024 ||
    /[\r\n]/.test(token) ||
    typeof expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    typeof accountId !== "string" ||
    !/^[0-9a-f]{32}$/.test(accountId)
  ) {
    throw new Error("Cloudflare STS exchange response was invalid");
  }

  console.log(`::add-mask::${token}`);
  output("token", token);
  output("expires-at", expiresAt);
  output("account-id", accountId);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
