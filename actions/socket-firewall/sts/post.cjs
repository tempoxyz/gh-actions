const { host, request, retry } = require("./http.cjs");

async function main() {
  const token = process.env.STATE_token || "";
  if (token === "") {
    console.log("No Socket token was minted; skipping revocation.");
    return;
  }
  if (!/^\S{20,4096}$/.test(token))
    throw new Error("stored Socket token is invalid");
  const body = JSON.stringify({ token });
  const response = await retry(() =>
    request(
      `https://${host(process.env.STATE_dev || "false")}/sts/revoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "tempoxyz-socket-sts-action",
        },
      },
      body,
    ),
  );
  if (response.status !== 204) {
    throw new Error(`Socket STS revocation failed (HTTP ${response.status})`);
  }
  console.log("Socket API token revoked.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
