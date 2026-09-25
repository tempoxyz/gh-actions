const { endpoint, request: httpRequest, retry } = require("./http.cjs");

function buildRevokeRequest(token, leaseId, rawHost) {
  const body = JSON.stringify({ token, lease_id: leaseId });
  return {
    url: `${endpoint(rawHost).origin}/sts/exchange`,
    options: {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "user-agent": "tempoxyz-step-security-sts-action",
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

// Revocation is best-effort. The STS lease expires on its own, so a revocation
// the STS cannot serve after retries must not turn a finished job red; it is
// reported as a warning instead. Corrupt state is different: it means this
// action misbehaved earlier, and it stays an error.
async function main({ env = process.env, request = httpRequest, sleep } = {}) {
  const token = env.STATE_token || "";
  if (token === "") {
    console.log("No Step Security API key was minted; skipping revocation.");
    return;
  }
  if (!/^\S{20,4096}$/.test(token))
    throw new Error("stored Step Security API key is invalid");
  const leaseId = env.STATE_lease_id || "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      leaseId,
    )
  )
    throw new Error("stored Step Security STS lease ID is invalid");
  const revoke = buildRevokeRequest(token, leaseId, env.STATE_sts_host || "");
  let response;
  try {
    response = await retry(
      (timeoutMs) => request(revoke.url, { ...revoke.options, timeoutMs }, revoke.body),
      { sleep },
    );
  } catch (error) {
    warning(
      "Step Security STS lease revocation failed",
      `Could not reach the Step Security STS to close the lease: ${error.message}. ` +
        "The lease expires on its own.",
    );
    return;
  }
  if (response.status !== 204) {
    warning(
      "Step Security STS lease revocation failed",
      `The Step Security STS answered HTTP ${response.status} when closing the lease. ` +
        "The lease expires on its own.",
    );
    return;
  }
  console.log("Step Security STS lease closed.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { buildRevokeRequest, main };
