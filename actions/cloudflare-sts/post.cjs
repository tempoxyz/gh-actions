const { request } = require("./http.cjs");
const { validateHost } = require("./host.cjs");
const { isTransientStatus, retry } = require("./retry.cjs");

function required(name) {
  const value = process.env[name] || "";
  if (value === "") throw new Error(`${name} is missing`);
  return value;
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function main() {
  const tokenId = process.env.STATE_token_id || "";
  if (tokenId === "") {
    console.log("No Cloudflare API token was minted; skipping deletion.");
    return;
  }
  if (!/^[0-9a-f]{32}$/.test(tokenId)) {
    throw new Error("stored Cloudflare token ID is invalid");
  }
  const account = process.env.STATE_account || "";
  if (!/^(?:dev|prd|infra)$/.test(account)) {
    throw new Error("stored Cloudflare account is invalid");
  }
  const identity = process.env.STATE_identity || "";
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(identity) ||
    identity === "." ||
    identity === ".."
  ) {
    throw new Error("stored Cloudflare STS identity is invalid");
  }
  const host = validateHost(required("STATE_host"));

  const oidcRequestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const oidcUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  oidcUrl.searchParams.set("audience", host);
  const oidcResponse = await retry(
    (timeoutMs) =>
      request(oidcUrl, {
        timeoutMs,
        headers: { Authorization: `Bearer ${oidcRequestToken}` },
      }),
    {
      label: "GitHub OIDC request",
      isTransient: (response) => isTransientStatus(response.status),
    },
  );
  if (oidcResponse.status < 200 || oidcResponse.status >= 300) {
    throw new Error(`GitHub OIDC request failed (HTTP ${oidcResponse.status})`);
  }
  const oidc = parseJson(oidcResponse.body).value;
  if (
    typeof oidc !== "string" ||
    oidc.length === 0 ||
    oidc.length > 16 * 1024 ||
    /[\r\n]/.test(oidc)
  ) {
    throw new Error("GitHub OIDC response did not contain a valid token");
  }

  const revokeUrl = new URL(`https://${host}/sts/exchange`);
  revokeUrl.searchParams.set("account", account);
  revokeUrl.searchParams.set("identity", identity);
  revokeUrl.searchParams.set("token_id", tokenId);
  const revokeResponse = await retry(
    (timeoutMs) =>
      request(revokeUrl, {
        method: "DELETE",
        timeoutMs,
        headers: { Authorization: `Bearer ${oidc}` },
      }),
    {
      label: "Cloudflare token deletion",
      isTransient: (response) => isTransientStatus(response.status),
    },
  );
  if (revokeResponse.status !== 204) {
    const body = parseJson(revokeResponse.body);
    const message =
      typeof body.message === "string"
        ? `: ${body.message.replace(/[\r\n]+/g, " ").slice(0, 500)}`
        : "";
    throw new Error(
      `Cloudflare STS token deletion failed (HTTP ${revokeResponse.status})${message}`,
    );
  }
  console.log("Cloudflare API token revoked and deleted.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
