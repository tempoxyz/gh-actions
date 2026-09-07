"use strict";

const fs = require("node:fs");
const {
  mintStepSecurityToken,
} = require("../harden-runner/mint.cjs");

const ENVIRONMENT_VARIABLE = "STEPSECURITY_API_KEY";

function requiredEnvironment(name, environment) {
  const value = environment[name] || "";
  if (!/^\S+$/.test(value)) throw new Error(`${name} is missing`);
  return value;
}

function maskSecret(value, log) {
  const escaped = value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  log(`::add-mask::${escaped}`);
}

function exportToken(value, environment) {
  if (!/^\S+$/.test(value)) {
    throw new Error("StepSecurity token cannot be exported safely");
  }
  const environmentFile = requiredEnvironment("GITHUB_ENV", environment);
  fs.appendFileSync(
    environmentFile,
    `${ENVIRONMENT_VARIABLE}=${value}\n`,
  );
}

async function getGitHubOidcToken(audience, { environment, fetchImpl }) {
  const requestToken = requiredEnvironment(
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    environment,
  );
  const requestUrl = new URL(
    requiredEnvironment("ACTIONS_ID_TOKEN_REQUEST_URL", environment),
  );
  if (requestUrl.protocol !== "https:") {
    throw new Error("GitHub OIDC request URL is invalid");
  }
  requestUrl.searchParams.set("audience", audience);

  const response = await fetchImpl(requestUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${requestToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC request failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.value !== "string" || !/^\S+$/.test(data.value)) {
    throw new Error("GitHub OIDC response returned no token");
  }
  return data.value;
}

async function main({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("StepSecurity token bootstrap requires fetch");
  }

  await mintStepSecurityToken({
    fetchImpl,
    core: {
      getIDToken: (audience) =>
        getGitHubOidcToken(audience, { environment, fetchImpl }),
      setSecret: (value) => maskSecret(value, log),
      setOutput(name, value) {
        if (name !== "token") {
          throw new Error(`Unexpected StepSecurity output: ${name}`);
        }
        exportToken(value, environment);
      },
    },
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ENVIRONMENT_VARIABLE,
  exportToken,
  getGitHubOidcToken,
  main,
  maskSecret,
};
