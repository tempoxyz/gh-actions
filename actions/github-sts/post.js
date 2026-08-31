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

function stsRevocationRequestOptions(token) {
  return {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "tempoxyz-gh-actions-github-sts",
    },
  };
}

async function revokeToken(token, stsHost, dependencies = {}) {
  const send = dependencies.request || request;
  const withRetry = dependencies.retry || retry;
  const log = dependencies.console || console;
  const knownStsHost = stsHost === "gh-sts.tehq.dev" || stsHost === "gh-sts.tehq.net";
  const stsUrl = knownStsHost ? `https://${stsHost}/sts/exchange` : null;
  let stsStatus = null;

  if (stsUrl) {
    try {
      stsStatus = await withRetry(
        () => send(stsUrl, stsRevocationRequestOptions(token)),
        { label: "STS token revocation", isTransient: isTransientStatus },
      );
    } catch {
      log.warn("STS token revocation could not reach STS; falling back to GitHub.");
    }
    if (stsStatus === 204) {
      log.log("GitHub App token revoked and STS ledger updated.");
      return;
    }
    if (stsStatus !== null) {
      log.warn(`STS token revocation returned HTTP ${stsStatus}; falling back to GitHub.`);
    }
  } else {
    log.warn("STS host state is unavailable; falling back to GitHub token revocation.");
  }

  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const providerStatus = await withRetry(
    () => send(`${apiUrl}/installation/token`, revocationRequestOptions(token)),
    { label: "GitHub token revocation", isTransient: isTransientStatus },
  );
  if (providerStatus !== 204 && providerStatus !== 401) {
    throw new Error(`Failed to revoke GitHub App token (HTTP ${providerStatus}).`);
  }

  // A provider fallback can still reconcile an existing ledger row: GitHub
  // returns 401 for the now-invalid credential, which STS treats as an
  // idempotent revocation success and uses to clear its stored copy.
  if (stsUrl) {
    try {
      if ((await send(stsUrl, stsRevocationRequestOptions(token))) === 204) {
        log.log("GitHub App token revoked and STS ledger updated.");
        return;
      }
    } catch {
      log.warn("STS ledger reconciliation could not reach STS.");
    }
  }

  const outcome = providerStatus === 204 ? "revoked" : "was already invalid or expired";
  log.warn(
    `GitHub App token ${outcome}; its STS ledger row is already clear or reconciliation remains pending.`,
  );
}

async function main() {
  const token = process.env.STATE_token;
  if (!token) {
    console.log("No GitHub App token was minted; skipping revocation.");
    return;
  }

  await revokeToken(token, process.env.STATE_sts_host);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { revocationRequestOptions, revokeToken, stsRevocationRequestOptions };
