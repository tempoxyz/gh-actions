const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RELEASE_TAG = "20260917T074427Z-cc48075c9387";
const RELEASE_COMMIT = "cc48075c9387ff084e819b70f96dba0e1e7daca9";
const RELEASE_VERSION = "cc48075c9387";

function assetName(runnerOS, runnerArch) {
  const operatingSystem = {
    Linux: ["linux", "deb"],
    macOS: ["macos", "tar.gz"],
    Windows: ["windows", "zip"],
  }[runnerOS];
  const architecture = { X64: "amd64", ARM64: "arm64" }[runnerArch];
  if (!operatingSystem) throw new Error(`Unsupported runner OS: ${runnerOS}`);
  if (!architecture) throw new Error(`Unsupported runner architecture: ${runnerArch}`);
  if (runnerOS === "macOS" && runnerArch === "X64") {
    throw new Error("This Aegis release supports only ARM64 macOS runners; Intel macOS is unsupported");
  }
  return `aegis-${RELEASE_VERSION}-${operatingSystem[0]}-${architecture}.${operatingSystem[1]}`;
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

function main() {
  const asset = assetName(process.env.RUNNER_OPERATING_SYSTEM, process.env.RUNNER_ARCHITECTURE);
  if (!process.env.GH_TOKEN) throw new Error("Aegis release token is missing");
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "aegis-release-"));
  execFileSync("gh", [
    "release", "download", RELEASE_TAG,
    "--repo", "tempoxyz/aegis",
    "--dir", directory,
    "--pattern", asset,
    "--pattern", "SHA256SUMS",
    "--pattern", "provenance.sigstore.json",
  ], { stdio: "inherit" });

  const artifact = path.join(directory, asset);
  const bundle = path.join(directory, "provenance.sigstore.json");
  const expected = expectedDigest(fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"), asset);
  assert.equal(sha256(artifact), expected, `${asset} does not match SHA256SUMS`);

  execFileSync("gh", [
    "attestation", "verify", artifact,
    "--repo", "tempoxyz/aegis",
    "--bundle", bundle,
    "--signer-workflow", "tempoxyz/aegis/.github/workflows/release.yml",
    "--source-digest", RELEASE_COMMIT,
    "--deny-self-hosted-runners",
  ], { stdio: "inherit" });

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

module.exports = { assetName, expectedDigest };
