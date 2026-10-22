const { databaseIds, namespaceIds } = require("./kv-output.cjs");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { brokerAudience, brokerEndpoint } = require("./endpoint.cjs");
const { brokerFailureMessage } = require("./error.cjs");
const {
  httpResponseError,
  permanentRequestError,
  request,
} = require("./request.cjs");
const { requestDeployment } = require("./retry.cjs");

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function input(name) {
  const key = name.toUpperCase();
  return (
    process.env[`INPUT_${key}`] ||
    process.env[`INPUT_${key.replaceAll("-", "_")}`] ||
    ""
  );
}

function valid(name, value, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function required(name, pattern) {
  return valid(name, process.env[name] || "", pattern);
}

function requiredInput(name, pattern) {
  return valid(name, input(name), pattern);
}

async function oidc(audience) {
  const token = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN", /^\S+$/);
  const rawUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL", /^https:\/\//);
  const url = new URL(rawUrl);
  url.searchParams.set("audience", audience);
  const response = await request(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status < 200 || response.status >= 300) {
    throw httpResponseError("GitHub OIDC request", response);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw permanentRequestError("GitHub OIDC response was invalid");
  }
  if (typeof parsed.value !== "string")
    throw permanentRequestError("GitHub OIDC response was invalid");
  return parsed.value;
}

async function main() {
  const deploymentId = requiredInput("deployment-id", /^[a-z][a-z0-9-]{0,62}$/);
  const artifactId = requiredInput("artifact-id", /^[1-9][0-9]{0,19}$/);
  const archiveSha256 = requiredInput("archive-digest", /^[0-9a-f]{64}$/);
  const moduleSha256 = requiredInput("module-digest", /^[0-9a-f]{64}$/);
  const runId = required("GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/);
  const runAttempt = required("GITHUB_RUN_ATTEMPT", /^[1-9][0-9]{0,9}$/);
  const commitSha = required("GITHUB_SHA", /^[0-9a-f]{40}$/);
  const repository = required(
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
  );
  const host = input("host");
  const endpoint = brokerEndpoint(host);
  const audience = brokerAudience(host);
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        repository,
        runId,
        runAttempt,
        deploymentId,
        artifactId,
        archiveSha256,
        moduleSha256,
        commitSha,
      }),
    )
    .digest("hex");
  const payload = JSON.stringify({
    deploymentId,
    artifact: {
      provider: "github-actions",
      runId,
      artifactId,
      archiveSha256,
      moduleSha256,
    },
    commitSha,
    idempotencyKey,
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
      brokerFailureMessage("deployment", response.status, result),
    );
  }
  const fields = {
    "managed-resources": JSON.stringify(result.managedResources ?? []),
    "kv-namespace-ids": namespaceIds(result.kvNamespaces),
    "d1-database-ids": databaseIds(result.d1Databases),
    "operation-id": result.operationId,
    "version-id": result.versionId,
    "deployment-id": result.deploymentId,
    "worker-name": result.workerName,
    "worker-tag": result.workerTag,
    "artifact-digest": result.normalizedArtifactDigest,
    "verification-url": result.verificationUrl,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw new Error(`Broker response did not contain a valid ${name}`);
    }
    output(name, value);
  }
  console.log(`Deployed ${result.workerName} version ${result.versionId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
