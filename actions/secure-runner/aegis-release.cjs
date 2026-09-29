const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { assetName, expectedDigest, ghEnvironment } = require("../aegis/download.cjs");
const { runCommand } = require("./command.cjs");

const ORIGIN = "https://aegis.tempoxyz.net";
const RELEASE_PATH = "/v1/actions/releases";
const AUDIENCE = ORIGIN;
const RELEASE_TAG = /^(?:v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})$/;
const TRANSFER_TIMEOUT_MS = 120_000;

function releaseChannel(tag) {
  return tag.startsWith("v") && !tag.slice(1).includes("-") ? "regular" : "pre-release";
}

async function request(url, getOidc, { fetcher = fetch, timeout = 10_000 } = {}) {
  const response = await fetcher(url, {
    headers: { "x-aegis-github-oidc-jwt": await getOidc(AUDIENCE) },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Aegis release server returned HTTP ${response.status} for ${new URL(url).pathname}`);
  return response;
}

async function retry(operation, description, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), jitter = 0) {
  let error;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); } catch (caught) {
      error = caught;
      if (attempt === 3) break;
      console.warn(`${description} failed (attempt ${attempt}/3); retrying.`);
      await sleep(Math.round(1000 * 2 ** (attempt - 1) * (1 + jitter * Math.random())));
    }
  }
  throw error;
}

function validateMetadata(metadata, tag, channel) {
  if (!metadata || metadata.tag !== tag || metadata.channel !== channel || metadata.prerelease !== (channel === "pre-release") ||
      typeof metadata.version !== "string" || !/^(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[0-9a-f]{12})$/.test(metadata.version) ||
      !/^[0-9a-f]{40}$/.test(metadata.source_commit)) {
    throw new Error("Aegis release server returned invalid release metadata");
  }
  const expectedVersion = tag.startsWith("v") ? tag.slice(1) : tag.slice(-12);
  if (metadata.version !== expectedVersion) throw new Error("Aegis release version does not match its tag");
  return metadata;
}

// Drain all started transfers before returning, including when one fails.
async function settle(operations) {
  const results = await Promise.allSettled(operations);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return results.map((result) => result.value);
}

async function downloadAssets({ version, getOidc, runnerOS, runnerArch, directory, fetcher, sleep }) {
  const options = { fetcher };
  let tag = version;
  if (!tag) {
    const response = await retry(() => request(`${ORIGIN}${RELEASE_PATH}/next?channel=regular`, getOidc, options), "Aegis latest release lookup", sleep);
    const latest = await response.json();
    tag = latest?.tag;
    if (typeof tag !== "string" || !RELEASE_TAG.test(tag) || releaseChannel(tag) !== "regular") {
      throw new Error("Aegis release server returned an invalid latest stable tag");
    }
  }
  const channel = releaseChannel(tag);
  const metadataResponse = await retry(() => request(`${ORIGIN}${RELEASE_PATH}/${channel}/${encodeURIComponent(tag)}`, getOidc, options), "Aegis release lookup", sleep);
  const metadata = validateMetadata(await metadataResponse.json(), tag, channel);
  const asset = assetName(metadata.version, runnerOS, runnerArch);
  await settle([asset, "SHA256SUMS", "provenance.sigstore.json"].map(async (name) => {
    const url = `${ORIGIN}${RELEASE_PATH}/${channel}/${encodeURIComponent(tag)}/assets/${name}`;
    await retry(async () => {
      const response = await request(url, getOidc, { fetcher, timeout: TRANSFER_TIMEOUT_MS });
      if (!response.body) throw new Error(`Aegis release asset ${name} has no body`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(path.join(directory, name)));
    }, `Aegis release asset ${name}`, sleep);
  }));
  const artifact = path.join(directory, asset);
  const expected = expectedDigest(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), asset);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  assert.equal(actual, expected, `${asset} does not match SHA256SUMS`);
  return { artifact, commit: metadata.source_commit };
}

async function downloadAndVerify({ version = "", getOidc, token, runnerOS, runnerArch, env = process.env,
  pathEntries = [], fetcher = fetch, execute = runCommand, sleep } = {}) {
  if (version && !RELEASE_TAG.test(version)) throw new Error(`Invalid Aegis release version: ${version}`);
  if (typeof getOidc !== "function") throw new Error("Aegis release OIDC provider is missing");
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "aegis-release-"));
  const trustedRoot = path.join(directory, "trusted_root.jsonl");
  const commandOptions = { timeout: 60_000, env: ghEnvironment(token, env, pathEntries) };
  // Fetch current roots using gh's authenticated TUF flow, independently of
  // release lookup and asset transfers. Never reuse a root file across jobs.
  const [{ artifact, commit }] = await settle([
    downloadAssets({ version, getOidc, runnerOS, runnerArch, directory, fetcher, sleep }),
    retry(async () => {
      // Truncate on every attempt so partial output cannot survive a retry.
      const output = fs.openSync(trustedRoot, "w", 0o600);
      try {
        await execute("gh", ["attestation", "trusted-root"], {
          ...commandOptions, stdio: ["ignore", output, "inherit"],
        });
      } finally {
        fs.closeSync(output);
      }
      if (fs.statSync(trustedRoot).size === 0) throw new Error("GitHub CLI returned no trusted roots");
    }, "Sigstore trusted-root download", sleep, 0.25),
  ]);
  await retry(() => execute("gh", [
    "attestation", "verify", artifact,
    "--repo", "tempoxyz/aegis",
    "--bundle", path.join(directory, "provenance.sigstore.json"),
    "--custom-trusted-root", trustedRoot,
    "--signer-workflow", "tempoxyz/aegis/.github/workflows/release.yml",
    "--source-digest", commit,
    "--source-ref", "refs/heads/main",
    "--deny-self-hosted-runners",
  ], { ...commandOptions, stdio: "inherit" }),
  "Aegis provenance verification", sleep, 0.25);
  return { package: artifact, directory };
}

module.exports = { AUDIENCE, ORIGIN, RELEASE_TAG, downloadAndVerify, releaseChannel, retry, validateMetadata };
