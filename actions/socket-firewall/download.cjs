const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1_000;
const GH_API_TIMEOUT_MS = 10 * 1000;

function sleep(delay) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function retrySync(operation, description, options = {}) {
  const attempts = options.attempts ?? DOWNLOAD_ATTEMPTS;
  const wait = options.sleep || sleep;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      console.warn(`${description} failed (attempt ${attempt}/${attempts}); retrying.`);
      wait(DOWNLOAD_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function runGh(args, description, options = {}) {
  const execute = options.execute || execFileSync;
  return retrySync(
    () => execute("gh", args, options.execOptions),
    description,
    options,
  );
}

function assetName(releaseVersion, runnerOS, runnerArch) {
  const operatingSystem = {
    Linux: ["linux", "deb"],
    macOS: ["macos", "tar.gz"],
    Windows: ["windows", "zip"],
  }[runnerOS];
  const architecture = { X64: "amd64", ARM64: "arm64" }[runnerArch];
  if (!operatingSystem) throw new Error(`Unsupported runner OS: ${runnerOS}`);
  if (!architecture) throw new Error(`Unsupported runner architecture: ${runnerArch}`);
  return `aegis-${releaseVersion}-${operatingSystem[0]}-${architecture}.${operatingSystem[1]}`;
}

function appendOutput(name, value, output = process.env.GITHUB_OUTPUT) {
  if (!output || /[\r\n]/.test(value)) throw new Error(`Invalid ${name} output`);
  fs.appendFileSync(output, `${name}=${value}\n`);
}

function expectedDigest(sums, asset) {
  const matches = sums
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line))
    .filter((match) => match && match[2] === asset);
  if (matches.length !== 1) throw new Error(`SHA256SUMS has no unique entry for ${asset}`);
  return matches[0][1];
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function latestRelease() {
  // GitHub's `/releases/latest` endpoint excludes draft and prerelease
  // releases, unlike the general releases list.
  const response = JSON.parse(runGh(
    ["api", "repos/tempoxyz/aegis/releases/latest"],
    "GitHub latest-release request",
    { execOptions: { encoding: "utf8", timeout: GH_API_TIMEOUT_MS } },
  ));
  if (response.draft || response.prerelease || typeof response.tag_name !== "string") {
    throw new Error("GitHub latest Aegis release is not a stable published release");
  }
  const match = /^v(\d+\.\d+\.\d+)$/.exec(response.tag_name);
  if (!match) throw new Error(`GitHub latest Aegis release has an invalid tag: ${response.tag_name}`);
  return { tag: response.tag_name, version: match[1] };
}

function releaseCommit(tag) {
  const commit = runGh(
    ["api", `repos/tempoxyz/aegis/git/ref/tags/${tag}`, "--jq", ".object.sha"],
    "GitHub release-commit request",
    { execOptions: { encoding: "utf8", timeout: GH_API_TIMEOUT_MS } },
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Aegis release ${tag} has an invalid source commit`);
  return commit;
}

function downloadReleaseAssets(tag, directory, asset) {
  const args = [
    "release", "download", tag,
    "--repo", "tempoxyz/aegis",
    "--dir", directory,
    // A failed attempt can have downloaded some of the requested assets.
    // Replace them on retry so checksum and provenance verification always
    // consume one complete download attempt.
    "--clobber",
    "--pattern", asset,
    "--pattern", "SHA256SUMS",
    "--pattern", "provenance.sigstore.json",
  ];
  // Do not impose a whole-process 10s timeout here: a healthy artifact
  // transfer can legitimately take longer. Each failed transfer is retried.
  runGh(args, "Aegis release download", { execOptions: { stdio: "inherit" } });
}

function main() {
  if (!process.env.GH_TOKEN) throw new Error("Aegis release token is missing");
  const release = latestRelease();
  const asset = assetName(release.version, process.env.RUNNER_OPERATING_SYSTEM, process.env.RUNNER_ARCHITECTURE);
  const commit = releaseCommit(release.tag);
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "aegis-release-"));
  downloadReleaseAssets(release.tag, directory, asset);

  const artifact = path.join(directory, asset);
  const bundle = path.join(directory, "provenance.sigstore.json");
  const expected = expectedDigest(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), asset);
  assert.equal(sha256(artifact), expected, `${asset} does not match SHA256SUMS`);

  runGh([
    "attestation", "verify", artifact,
    "--repo", "tempoxyz/aegis",
    "--bundle", bundle,
    "--signer-workflow", "tempoxyz/aegis/.github/workflows/release.yml",
    "--source-digest", commit,
    "--source-ref", "refs/heads/main",
    "--deny-self-hosted-runners",
  ], "Aegis provenance verification", { execOptions: { stdio: "inherit" } });

  appendOutput("package", artifact);
  appendOutput("directory", directory);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  GH_API_TIMEOUT_MS,
  assetName,
  expectedDigest,
  downloadReleaseAssets,
  retrySync,
  runGh,
};
