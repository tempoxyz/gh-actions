const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { assetName, expectedDigest, ghEnvironment, retrySync } = require("../aegis/download.cjs");
const timing = require("./phase-timing.cjs");

const ORIGIN = "https://aegis.tempoxyz.net";
const RELEASE_PATH = "/v1/actions/releases";
const AUDIENCE = ORIGIN;
const RELEASE_TAG = /^(?:v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})$/;
const TRANSFER_TIMEOUT_MS = 120_000;

function releaseChannel(tag) {
  return tag.startsWith("v") && !tag.slice(1).includes("-") ? "regular" : "pre-release";
}

async function request(url, getOidc, { fetcher = fetch, timeout = 10_000 } = {}) {
  const jwt = await timing.timed("release_oidc_wait", () => getOidc(AUDIENCE));
  const started = timing.now();
  const response = await fetcher(url, {
    headers: { "x-aegis-github-oidc-jwt": jwt },
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
  });
  response.benchmarkStarted = started;
  response.benchmarkHeaders = timing.now();
  timing.record("release_http_headers", started, { asset: new URL(url).pathname.split("/").at(-1) });
  if (!response.ok) throw new Error(`Aegis release server returned HTTP ${response.status} for ${new URL(url).pathname}`);
  return response;
}

async function retry(operation, description, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let error;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); } catch (caught) {
      error = caught;
      if (attempt === 3) break;
      console.warn(`${description} failed (attempt ${attempt}/3); retrying.`);
      await sleep(1000 * 2 ** (attempt - 1));
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

async function downloadAndVerify({ version = "", getOidc, token, runnerOS, runnerArch, env = process.env,
  pathEntries = [], fetcher = fetch, execute = execFileSync, sleep } = {}) {
  if (version && !RELEASE_TAG.test(version)) throw new Error(`Invalid Aegis release version: ${version}`);
  if (typeof getOidc !== "function") throw new Error("Aegis release OIDC provider is missing");
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
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "aegis-release-"));
  for (const name of [asset, "SHA256SUMS", "provenance.sigstore.json"]) {
    const url = `${ORIGIN}${RELEASE_PATH}/${channel}/${encodeURIComponent(tag)}/assets/${name}`;
    await retry(async () => {
      const response = await request(url, getOidc, { fetcher, timeout: TRANSFER_TIMEOUT_MS });
      if (!response.body) throw new Error(`Aegis release asset ${name} has no body`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(path.join(directory, name)));
      timing.record("asset_request_and_body", response.benchmarkStarted, {
        asset: name, headers: response.benchmarkHeaders,
        bytes: fs.statSync(path.join(directory, name)).size,
        cache: response.headers.get("cf-cache-status"),
      });
    }, `Aegis release asset ${name}`, sleep);
  }
  const artifact = path.join(directory, asset);
  const checksumStarted = timing.now();
  const expected = expectedDigest(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), asset);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  assert.equal(actual, expected, `${asset} does not match SHA256SUMS`);
  timing.record("checksum_verify", checksumStarted);
  const attestationStarted = timing.now();
  retrySync(() => execute("gh", [
    "attestation", "verify", artifact,
    "--repo", "tempoxyz/aegis",
    "--bundle", path.join(directory, "provenance.sigstore.json"),
    "--signer-workflow", "tempoxyz/aegis/.github/workflows/release.yml",
    "--source-digest", metadata.source_commit,
    "--source-ref", "refs/heads/main",
    "--deny-self-hosted-runners",
  ], { stdio: "inherit", timeout: 60_000, env: ghEnvironment(token, env, pathEntries) }),
  "Aegis provenance verification");
  timing.record("attestation_verify", attestationStarted);
  return { package: artifact, directory };
}

module.exports = { AUDIENCE, ORIGIN, RELEASE_TAG, downloadAndVerify, releaseChannel, validateMetadata };
