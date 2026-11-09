import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { download } from './download.mjs';

export { download, retryDelay, verifyChecksum } from './download.mjs';

export const releases = JSON.parse(readFileSync(new URL('./releases.json', import.meta.url)));

export function assetNames(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  if (!os || !cpu) throw new Error(`Unsupported OSV platform: ${platform}/${arch}`);
  const suffix = `${os}_${cpu}${platform === 'win32' ? '.exe' : ''}`;
  return { scanner: `osv-scanner_${suffix}`, verifier: `slsa-verifier-${suffix.replace('_', '-')}` };
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
