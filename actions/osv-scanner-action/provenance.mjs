// Verifies SLSA provenance for every asset pinned in releases.json, on every platform.
// Runs in this repository's CI (not in consumers' scans), so a releases.json bump only
// merges once each pinned scanner and verifier binary is proven to come from its
// upstream repository at the exact release tag. Needs Sigstore (Rekor) access.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assetNames, childEnvironment, download, releases } from './install.mjs';

const VERIFY_ATTEMPTS = 3;

export function platformAssets() {
  const scanners = [], verifiers = [];
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    const names = assetNames(platform, arch);
    scanners.push(names.scanner);
    verifiers.push(names.verifier);
  }
  return { scanners, verifiers };
}

// Rekor lookups can time out; a genuine verification failure fails every attempt.
export function verifyWithRetry(verifier, args, options, execute, sleep) {
  let result;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    result = execute(verifier, args, options);
    if (!result.error && result.status === 0) return;
    if (attempt < VERIFY_ATTEMPTS - 1) sleep(5_000 * 2 ** attempt);
  }
  throw result.error || new Error(`SLSA verification failed for ${args[1]} (exit ${result.status})`);
}

function sleepSync(delay) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

export async function verifyProvenance(env = process.env, { execute = spawnSync, sleep = sleepSync, ...options } = {}) {
  const directory = join(env.RUNNER_TEMP || tmpdir(), `tempo-osv-provenance-${releases.scanner.version}-${releases.verifier.version}`);
  mkdirSync(directory, { recursive: true });
  const fetchAll = (release, names) => Promise.all(names.map(name => download(release, name, directory, options)));
  const { scanners, verifiers } = platformAssets();
  const [scannerPaths, verifierPaths, [scannerProvenance]] = await Promise.all([
    fetchAll(releases.scanner, scanners),
    fetchAll(releases.verifier, verifiers),
    fetchAll(releases.scanner, ['multiple.intoto.jsonl']),
  ]);
  const verifierProvenance = await fetchAll(releases.verifier, verifiers.map(name => `${name}.intoto.jsonl`));
  // The host's verifier is bootstrapped from its pinned digest and checks itself first.
  const host = verifierPaths[verifiers.indexOf(assetNames().verifier)];
  if (process.platform !== 'win32') chmodSync(host, 0o700);
  const verifierChecks = verifierPaths.map((path, i) => [path, verifierProvenance[i], releases.verifier]);
  const checks = [
    ...verifierChecks.filter(([path]) => path === host),
    ...verifierChecks.filter(([path]) => path !== host),
    ...scannerPaths.map(path => [path, scannerProvenance, releases.scanner]),
  ];
  const spawnOptions = { cwd: directory, env: childEnvironment(env), stdio: 'inherit' };
  for (const [binary, provenance, release] of checks) {
    verifyWithRetry(host, ['verify-artifact', binary, '--provenance-path', provenance,
      '--source-uri', `github.com/${release.repository}`, '--source-tag', release.version], spawnOptions, execute, sleep);
  }
  return { verifier: host, directory, verified: checks.map(([binary]) => binary) };
}

// A correctly signed artifact must still be rejected for another source repository.
export function rejectsWrongIdentity({ verifier, directory }, env = process.env, execute = spawnSync) {
  const scanner = join(directory, assetNames().scanner);
  const result = execute(verifier, ['verify-artifact', scanner,
    '--provenance-path', join(directory, 'multiple.intoto.jsonl'),
    '--source-uri', 'github.com/tempoxyz/gh-actions', '--source-tag', releases.scanner.version],
  { env: childEnvironment(env), encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error('Wrong provenance identity was accepted');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyProvenance()
    .then(verified => {
      rejectsWrongIdentity(verified);
      console.log(`PASS: SLSA provenance for ${verified.verified.length} pinned binaries`);
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

