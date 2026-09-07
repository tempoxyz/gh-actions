"use strict";

const AUDIENCE = "tempoxyz.api.stepsecurity.io";
const TOKEN_URL = "https://agent.api.stepsecurity.io/v1/tempoxyz/oidc/token";

async function mintStepSecurityToken({ core, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("StepSecurity token exchange requires fetch");
  }

  const githubOidcToken = await core.getIDToken(AUDIENCE);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ github_oidc_token: githubOidcToken }),
  });

  if (!response.ok) {
    throw new Error(`StepSecurity token exchange failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data.token !== "string" || data.token.trim() === "") {
    throw new Error("StepSecurity token exchange returned no token");
  }

  core.setSecret(data.token);
  core.setOutput("token", data.token);
}

module.exports = {
  AUDIENCE,
  TOKEN_URL,
  mintStepSecurityToken,
};
