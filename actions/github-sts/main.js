const fs = require("node:fs");
const https = require("node:https");
const { host } = require("./host.js");
const { isTransientStatus, retry, retryAfterMs } = require("./retry.js");

const REQUEST_TIMEOUT_MS = 10 * 1000;

function input(name) {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replaceAll("-", "_")}`] || "";
}

function request(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let timeout;
    const clearRequestTimeout = () => clearTimeout(timeout);
    const call = https.request(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        clearRequestTimeout();
        resolve({ status: response.statusCode, body, headers: response.headers });
      });
    });
    timeout = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      call.destroy(error);
    }, timeoutMs);
    call.on("error", (error) => {
      clearRequestTimeout();
      reject(error);
    });
    call.end();
  });
}

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function buildExchangeUrl(host, scope, policy, ttl) {
  const url = new URL(`https://${host}/sts/exchange`);
  url.searchParams.set("scope", scope);
  url.searchParams.set("identity", policy);
  if (ttl) url.searchParams.set("ttl", ttl);
  return url;
}

function exchangeRequestOptions(oidc) {
  return {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${oidc}`,
      "User-Agent": "tempoxyz-gh-actions-github-sts",
    },
  };
}

async function main() {
  const stsHost = host(input("host") || "gh-sts.tempoxyz.net");

  const oidcRequestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const oidcRequestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!oidcRequestToken) throw new Error("id-token: write permission is required");
  if (!oidcRequestUrl) throw new Error("GitHub OIDC request URL is unavailable");

  const budgetMs = retryTimeoutMs(input("retry-timeout"));
  const deadlineMs = Date.now() + budgetMs;
  const send = (url, options) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("GitHub STS retry timeout exceeded.");
    return request(url, options, Math.min(REQUEST_TIMEOUT_MS, remaining));
  };
  const retryOptions = {
    deadlineMs,
    isTransient: (response) => isTransientStatus(response.status),
    getDelayMs: retryAfterMs,
  };

  const oidcUrl = new URL(oidcRequestUrl);
  oidcUrl.searchParams.set("audience", stsHost);
  const getOidc = async () => {
    const response = await retry(
      () => send(oidcUrl, { headers: { Authorization: `Bearer ${oidcRequestToken}` } }),
      { ...retryOptions, label: "GitHub OIDC request" },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub OIDC request failed (HTTP ${response.status})`);
    }
    const value = JSON.parse(response.body).value;
    if (typeof value !== "string" || !value) throw new Error("GitHub OIDC response did not contain a token");
    return value;
  };

  const scope = input("scope") || process.env.GITHUB_REPOSITORY;
  // TTL parsing and bounds enforcement are deliberately server-side so a
  // modified or older action cannot bypass policy constraints.
  const exchangeUrl = buildExchangeUrl(stsHost, scope, input("policy"), input("ttl"));
  const exchangeResponse = await exchangeWithRetry(exchangeUrl, getOidc, send, retryOptions);

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
  fs.appendFileSync(process.env.GITHUB_STATE, `token=${token}\nsts_host=${stsHost}\n`);
}

function retryTimeoutMs(value = "") {
  const seconds = value === "" ? 300 : Number(value);
  if ((value !== "" && !/^\d+$/.test(value)) || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("retry-timeout must be an integer from 1 to 3600 seconds");
  }
  return seconds * 1000;
}

async function exchangeWithRetry(url, getOidc, send, options) {
  let oidc = await getOidc();
  let refresh = false;
  return retry(async () => {
    // A 429 explicitly rejected the exchange. Refresh after the wait, as the
    // assertion may have expired. Reuse it after ambiguous failures so STS can
    // replay the original result instead of minting a duplicate credential.
    if (refresh) {
      oidc = await getOidc();
      refresh = false;
    }
    const response = await send(url, exchangeRequestOptions(oidc));
    refresh = response.status === 429;
    return response;
  }, { ...options, label: "STS worker exchange" });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { REQUEST_TIMEOUT_MS, buildExchangeUrl, exchangeRequestOptions, exchangeWithRetry, main, request, retryTimeoutMs };
