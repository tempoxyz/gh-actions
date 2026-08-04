const https = require("node:https");
const { isTransientStatus, retry } = require("./retry.js");

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, options, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

function revocationRequestOptions(token) {
  return {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "tempoxyz-gh-actions-github-sts",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  };
}

async function main() {
  const token = process.env.STATE_token;
  if (!token) {
    console.log("No GitHub App token was minted; skipping revocation.");
    return;
  }

  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const status = await retry(
    () => request(`${apiUrl}/installation/token`, revocationRequestOptions(token)),
    { label: "GitHub token revocation", isTransient: isTransientStatus },
  );

  if (status === 204) {
    console.log("GitHub App token revoked.");
  } else if (status === 401) {
    console.log("GitHub App token was already invalid or expired; revocation was not needed.");
  } else {
    throw new Error(`Failed to revoke GitHub App token (HTTP ${status}).`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { revocationRequestOptions };
