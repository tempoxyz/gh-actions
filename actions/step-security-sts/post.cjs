const { endpoint, request, retry } = require("./http.cjs");

function buildRevokeRequest(token, leaseId, rawEndpoint) {
  const body = JSON.stringify({ token, lease_id: leaseId });
  return {
    url: `${endpoint(rawEndpoint).origin}/sts/exchange`,
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

async function main() {
  const token = process.env.STATE_token || "";
  if (token === "") {
    console.log("No Step Security API key was minted; skipping revocation.");
    return;
  }
  if (!/^\S{20,4096}$/.test(token))
    throw new Error("stored Step Security API key is invalid");
  const leaseId = process.env.STATE_lease_id || "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      leaseId,
    )
  )
    throw new Error("stored Step Security STS lease ID is invalid");
  const revoke = buildRevokeRequest(
    token,
    leaseId,
    process.env.STATE_sts_url || "",
  );
  const response = await retry(() =>
    request(revoke.url, revoke.options, revoke.body),
  );
  if (response.status !== 204) {
    throw new Error(
      `Step Security STS revocation failed (HTTP ${response.status})`,
    );
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
