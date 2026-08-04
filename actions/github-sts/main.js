const fs = require("node:fs");
const https = require("node:https");
const { isTransientStatus, retry } = require("./retry.js");

function input(name) {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replaceAll("-", "_")}`] || "";
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const dev = input("dev");
const host = dev === "true" ? "gh-sts.tehq.dev" : dev === "false" ? "gh-sts.tehq.net" : null;
if (!host) throw new Error("dev must be either true or false");

const cert = input("client-cert");
const key = input("client-key");
if (!cert || !key) throw new Error("client-cert and client-key must be provided");

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
const oidc = JSON.parse(oidcResponse.body).value;

const scope = input("scope") || process.env.GITHUB_REPOSITORY;
const exchangeUrl = new URL(`https://${host}/sts/exchange`);
exchangeUrl.searchParams.set("scope", scope);
exchangeUrl.searchParams.set("identity", input("policy"));
const exchangeResponse = await retry(
  () => request(exchangeUrl, {
    cert,
    key,
    headers: { Authorization: `Bearer ${oidc}` },
  }),
  { label: "STS worker exchange", isTransient: (response) => isTransientStatus(response.status) },
);

let exchangeBody;
try {
  exchangeBody = JSON.parse(exchangeResponse.body);
} catch {
  exchangeBody = {};
}
if (exchangeResponse.status < 200 || exchangeResponse.status >= 300) {
  const message = typeof exchangeBody.message === "string" ? `: ${exchangeBody.message.replace(/[\r\n]+/g, " ").slice(0, 500)}` : "";
  throw new Error(`GitHub STS exchange failed (HTTP ${exchangeResponse.status})${message}`);
}

const token = exchangeBody.token;
const expiresAt = exchangeBody.expires_at;
if (typeof token !== "string" || typeof expiresAt !== "string") {
  throw new Error("GitHub STS exchange response did not contain token and expires_at");
}

console.log(`::add-mask::${token}`);
output("token", token);
output("expires-at", expiresAt);
fs.appendFileSync(process.env.GITHUB_STATE, `token=${token}\n`);
