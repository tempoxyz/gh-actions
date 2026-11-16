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
} = require("../cloudflare-deploy-broker/github.cjs");
const { request } = require("../cloudflare-deploy-broker/request.cjs");
const { requestDeployment } = require("../cloudflare-deploy-broker/retry.cjs");

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function main() {
  const deploymentId = requiredInput("deployment-id", /^[a-z][a-z0-9-]{0,62}$/);
  const operationId = requiredInput("operation-id", UUID);
  const action = requiredInput("action", /^(?:promote|rollback)$/);
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/);
  const commitSha = required("GITHUB_SHA", /^[0-9a-f]{40}$/);
  const host = input("host");
  const endpoint = brokerEndpoint(host);
  const audience = brokerAudience(host);
  // The broker binds the request to the run attempt that staged the rollout,
  // from the OIDC token. Both actions are idempotent, so retries are safe.
  const payload = JSON.stringify({
    operation: action,
    deploymentId,
    operationId,
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
      brokerFailureMessage(
        action === "promote" ? "promotion" : "rollback",
        response.status,
        result,
      ),
    );
  }
  const expectedState = action === "promote" ? "promoted" : "rolled_back";
  if (
    result.operationId !== operationId ||
    result.action !== action ||
    result.state !== expectedState ||
    ![
      result.versionId,
      result.deploymentId,
      result.stableVersionId,
      result.candidateVersionId,
    ].every((value) => typeof value === "string" && UUID.test(value)) ||
    result.versionId !==
      (action === "promote"
        ? result.candidateVersionId
        : result.stableVersionId) ||
    typeof result.changed !== "boolean"
  ) {
    throw new Error(`Broker response did not contain a valid ${action}`);
  }
  output("operation-id", result.operationId);
  output("state", result.state);
  output("version-id", result.versionId);
  output("deployment-id", result.deploymentId);
  output("stable-version-id", result.stableVersionId);
  output("candidate-version-id", result.candidateVersionId);
  output("changed", String(result.changed));
  const verb = action === "promote" ? "Promoted" : "Restored";
  console.log(
    `${verb} ${result.workerName} version ${result.versionId}${result.changed ? "" : " (already live)"}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
