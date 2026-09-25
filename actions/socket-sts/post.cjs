const { host, request: httpRequest, retry } = require("./http.cjs");
const { uploadAegisReport } = require("./dist/artifact-upload.cjs");

function buildRevokeRequest(token, endpoint) {
  const body = JSON.stringify({ token });
  return {
    url: `https://${host(endpoint)}/sts/exchange`,
    options: {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "tempoxyz-socket-sts-action",
      },
    },
    body,
  };
}

function escapeAnnotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function warning(title, message) {
  const property = escapeAnnotation(title).replaceAll(":", "%3A").replaceAll(",", "%2C");
  console.log(`::warning title=${property}::${escapeAnnotation(message)}`);
}

// Revocation is best-effort. The STS lease expiration bounds the token's
// lifetime, so a revocation the STS cannot serve after retries must not turn a
// finished job red; it is reported as a warning instead. Corrupt state is
// different: it means this action misbehaved earlier, and it stays an error.
async function main({
  env = process.env,
  request = httpRequest,
  upload = uploadAegisReport,
  sleep,
} = {}) {
  const token = env.STATE_token || "";
  if (token === "") {
    console.log("No Socket token was minted; skipping revocation.");
    return;
  }
  if (!/^\S{20,4096}$/.test(token))
    throw new Error("stored Socket token is invalid");
  try {
    const revoke = buildRevokeRequest(
      token,
      env.STATE_host || "socket-sts.tempoxyz.net",
    );
    let response;
    try {
      response = await retry(
        (timeoutMs) => request(revoke.url, { ...revoke.options, timeoutMs }, revoke.body),
        { sleep },
      );
    } catch (error) {
      warning(
        "Socket STS token revocation failed",
        `Could not reach the Socket STS to revoke the token: ${error.message}. ` +
          "The STS lease expiration still bounds the token's lifetime.",
      );
      return;
    }
    if (response.status !== 204) {
      warning(
        "Socket STS token revocation failed",
        `The Socket STS answered HTTP ${response.status} when revoking the token. ` +
          "The STS lease expiration still bounds the token's lifetime.",
      );
      return;
    }
    console.log("Socket API token revoked.");
  } finally {
    if (env.STATE_upload_aegis_report === "true") {
      try {
        await retry(
          () => upload({ action: env.STATE_action || "socket-sts" }),
          { retryHttpResponses: false, sleep },
        );
      } catch (error) {
        console.log(`::warning title=Aegis audit-log upload failed::${error.message}`);
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildRevokeRequest, main };
