const {
  brokerAudience,
  brokerEndpoint,
} = require("../cloudflare-deploy-broker/endpoint.cjs");
const {
  brokerFailureMessage,
} = require("../cloudflare-deploy-broker/error.cjs");
const {
  input,
  oidc,
  output,
  required,
  requiredInput,
  valid,
} = require("../cloudflare-deploy-broker/github.cjs");
const { request } = require("../cloudflare-deploy-broker/request.cjs");
const { requestDeployment } = require("../cloudflare-deploy-broker/retry.cjs");

async function main() {
  const deploymentId = requiredInput("deployment-id", /^[a-z][a-z0-9-]{0,62}$/);
  const accountId = requiredInput("account-id", /^[0-9a-f]{32}$/);
  const workerName = requiredInput(
    "worker-name",
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
  const previewName = input("preview-name");
  if (previewName !== "") valid("preview-name", previewName, /^pr-[1-9][0-9]{0,9}$/);
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/);
  const commitSha = required("GITHUB_SHA", /^[0-9a-f]{40}$/);
  const host = input("host");
  const endpoint = brokerEndpoint(host);
  const audience = brokerAudience(host);
  // GitHub runs a merged pull request's closing workflow on main, whose
  // identity has no pull request number, so that run names the preview. An
  // unmerged pull request may delete only its own preview, whatever it names.
  const payload = JSON.stringify({
    operation: "delete-preview",
    ...(previewName === "" ? {} : { previewName }),
    deploymentId,
    accountId,
    workerName,
    commitSha,
    runId,
  });

  const { response, result } = await requestDeployment(async () => {
    const bearer = await oidc(audience);
    return request(
      new URL("/v1/deploy", endpoint),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "user-agent": "tempoxyz-cloudflare-deploy-broker-action",
        },
      },
      payload,
    );
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      brokerFailureMessage("preview deletion", response.status, result),
    );
  }
  if (
    typeof result.operationId !== "string" ||
    !/^pr-[1-9][0-9]{0,9}$/.test(result.previewName) ||
    typeof result.deleted !== "boolean"
  ) {
    throw new Error("Broker response did not contain a valid preview deletion");
  }
  output("operation-id", result.operationId);
  output("preview-name", result.previewName);
  output("deleted", String(result.deleted));
  console.log(
    result.deleted
      ? `Deleted preview ${result.previewName} of ${workerName}`
      : `Preview ${result.previewName} of ${workerName} was already deleted`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
