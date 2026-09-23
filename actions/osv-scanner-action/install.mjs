import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const releases = JSON.parse(readFileSync(new URL('./releases.json', import.meta.url)));

export function assetNames(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) throw new Error(`Unsupported OSV platform: ${platform}/${arch}`);
  const suffix = `${os}_${cpu}${platform === 'win32' ? '.exe' : ''}`;
  return { scanner: `osv-scanner_${suffix}`, verifier: `slsa-verifier-${suffix.replace('_', '-')}` };
}

export function verifyChecksum(bytes, expected, name) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Checksum mismatch: ${name}`);
}

const DOWNLOAD_ATTEMPTS = 3;

function exponentialDelay(attempt) {
  return 1_000 * 2 ** attempt;
}

function retryAfterDelay(headers, now = Date.now()) {
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  if (typeof value !== 'string') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryableStatus(status) {
  return status === 409 || status === 429 || (status >= 500 && status <= 599);
}

export function retryDelay(response, attempt, now = Date.now()) {
  return response.status === 429
    ? retryAfterDelay(response.headers, now) ?? exponentialDelay(attempt)
    : exponentialDelay(attempt);
}

export async function download(
  release,
  name,
  directory,
  { fetch: request = fetch, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {},
) {
  const path = join(directory, name);
  const expected = release.assets[name];
  if (!expected) throw new Error(`No pinned checksum for ${name}`);
  if (existsSync(path)) {
    verifyChecksum(readFileSync(path), expected, name);
    return path;
  }
  const url = `https://github.com/${release.repository}/releases/download/${release.version}/${name}`;
  let lastError;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) {
        lastError = new Error(`Download ${name}: HTTP ${response.status}`);
        if (!retryableStatus(response.status) || attempt === DOWNLOAD_ATTEMPTS - 1) break;
        await sleep(retryDelay(response, attempt));
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyChecksum(bytes, expected, name);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, bytes, { mode: 0o700 });
      renameSync(temporary, path);
      return path;
    } catch (error) {
      lastError = error;
      if (attempt === DOWNLOAD_ATTEMPTS - 1) break;
      await sleep(exponentialDelay(attempt));
    }
  }
  throw lastError;
}

// Avoid exposing workflow tokens, git credential settings, or process injection
// variables to the verifier and scanner. Windows environment keys are case-insensitive.
export function childEnvironment(env) {
  const allowed = new Set(['path', 'home', 'userprofile', 'systemroot', 'windir', 'comspec',
    'pathext', 'temp', 'tmp', 'tmpdir', 'localappdata', 'appdata', 'lang', 'lc_all',
    'ssl_cert_file', 'ssl_cert_dir']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())));
}

export async function install(env = process.env, execute = spawnSync) {
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required');
  const names = assetNames();
  const directory = join(env.RUNNER_TEMP, `tempo-osv-${releases.scanner.version}-${releases.verifier.version}-${process.platform}-${process.arch}`);
  mkdirSync(directory, { recursive: true });
  const [scanner, verifier, scannerProvenance, verifierProvenance] = await Promise.all([
    download(releases.scanner, names.scanner, directory),
    download(releases.verifier, names.verifier, directory),
    download(releases.scanner, 'multiple.intoto.jsonl', directory),
    download(releases.verifier, `${names.verifier}.intoto.jsonl`, directory),
  ]);
  if (process.platform !== 'win32') { chmodSync(scanner, 0o700); chmodSync(verifier, 0o700); }
  // The verifier is bootstrapped from a pinned digest and verifies its own SLSA
  // provenance before verifying the scanner's publisher and exact release tag.
  for (const [binary, provenance, release] of [
    [verifier, verifierProvenance, releases.verifier],
    [scanner, scannerProvenance, releases.scanner],
  ]) {
    const result = execute(verifier, ['verify-artifact', binary, '--provenance-path', provenance,
      '--source-uri', `github.com/${release.repository}`, '--source-tag', release.version],
    { cwd: directory, env: childEnvironment(env), stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      rmSync(scanner, { force: true });
      throw result.error || new Error(`SLSA verification failed for ${release.repository} (exit ${result.status})`);
    }
  }
  return scanner;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  install().then(path => console.log(path)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
