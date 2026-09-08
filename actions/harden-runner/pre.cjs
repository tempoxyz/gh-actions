const {
  append,
  exchangeToken,
  maskSecret,
  required,
} = require("../step-security-sts/main.cjs");
const { runHardenRunner } = require("./run.cjs");

async function main() {
  // Harden Runner reads the policy in its pre-job entrypoint. Mint the key in
  // this same pre-job process so it exists before that entrypoint starts.
  const result = await exchangeToken();
  maskSecret(result.token);
  append(required("GITHUB_STATE"), "token", result.token);
  append(required("GITHUB_STATE"), "lease_id", result.leaseId);
  append(required("GITHUB_STATE"), "sts_url", result.rawEndpoint);
  runHardenRunner("pre", result.token);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
