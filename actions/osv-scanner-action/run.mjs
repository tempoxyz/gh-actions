import { appendFileSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Upstream v2.6.0 multi-architecture image. Its release workflow publishes no
// container signature; pin the registry manifest digest rather than a mutable tag.
export const IMAGE = 'ghcr.io/google/osv-scanner-action@sha256:71ad04ab2f8798be47870f9b18817ad317c2f8f2f97aa6726ba10d5578bc174a';

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function readResults(path) {
  // A missing or malformed report must never become an empty, passing diff.
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular results file: ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || !Object.hasOwn(data, 'results') || (data.results !== null && !Array.isArray(data.results))) throw new Error(`Invalid OSV results: ${path}`);
  return data;
}

export function run(env = process.env, execute = spawnSync) {
  const workspace = realpathSync(env.GITHUB_WORKSPACE);
  const results = realpathSync(env.OSV_RESULTS_DIRECTORY);
  if (!inside(realpathSync(env.RUNNER_TEMP), results) || results === workspace || inside(workspace, results)) {
    throw new Error('Results directory must be under RUNNER_TEMP and outside the checkout');
  }
  if ([workspace, results].some(path => /[,\r\n]/.test(path))) throw new Error('Unsupported mount path');
  const mode = env.OSV_MODE || 'scan';
  if (!['scan', 'report'].includes(mode)) throw new Error('mode must be scan or report');
  const failOnVuln = env.OSV_FAIL_ON_VULN || 'true';
  if (!['true', 'false'].includes(failOnVuln)) throw new Error('fail-on-vuln must be true or false');

  let args;
  let output;
  if (mode === 'scan') {
    const name = env.OSV_RESULTS_FILE || 'results.json';
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error('results-file must be a simple JSON filename');
    output = join(results, name);
    // Remove stale files before starting, including any pre-existing symlink.
    rmSync(output, { force: true });
    const extra = (env.OSV_SCAN_ARGS || '--recursive\n./').split(/\r?\n/).map(arg => arg.trim()).filter(Boolean);
    if (extra.some(arg => /^--?(format|output|output-file|output-files|call-analysis|no-call-analysis)(=|$)/.test(arg) || /^-f/.test(arg))) {
      throw new Error('Output format, output paths, and call analysis are managed by the action');
    }
    args = ['scan', 'source', '--format=json', `--output-file=/results/${name}`,
      '--allow-no-lockfiles', '--no-call-analysis=go,rust', ...extra];
  } else {
    readResults(join(results, 'old-results.json'));
    readResults(join(results, 'new-results.json'));
    output = join(results, 'diff.json');
    for (const name of ['diff.json', 'results.sarif', 'summary.md']) rmSync(join(results, name), { force: true });
    args = ['--old=/results/old-results.json', '--new=/results/new-results.json',
      '--output-files=json:/results/diff.json', '--output-files=sarif:/results/results.sarif',
      '--output-files=markdown:/results/summary.md', '--output-files=table:#stdout',
      '--output-files=gh-annotations:#stderr', '--fail-on-vuln=true'];
  }
  const dockerArgs = ['run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--mount', `type=bind,source=${workspace},target=/github/workspace,readonly`,
    '--mount', `type=bind,source=${results},target=/results`,
    '--workdir', '/github/workspace', '--env', 'GOTOOLCHAIN=auto',
    '--env', 'GITHUB_WORKSPACE=/github/workspace',
    '--entrypoint', mode === 'scan' ? '/root/osv-scanner' : '/root/osv-reporter', IMAGE, ...args];
  // No shell expansion and no GitHub/OIDC credentials are passed to the container.
  // Bypass upstream's entrypoint, which silently converts exit 128 into success.
  const result = execute('docker', dockerArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) throw new Error(`OSV ${mode} failed (exit ${result.status}, signal ${result.signal})`);
  readResults(output);
  const found = result.status === 1;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `vulnerabilities-found=${found}\n`);
  if (mode === 'report' && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Dependency Vulnerability Scan\n\n${readFileSync(join(results, 'summary.md'), 'utf8')}\n`);
  }
  if (mode === 'report' && found && failOnVuln === 'true') throw new Error('New dependency vulnerabilities found');
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { run(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
