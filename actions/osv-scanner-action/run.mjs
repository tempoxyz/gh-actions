import { appendFileSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { childEnvironment, install } from './install.mjs';
import { diffResults, validateResults, writeReport } from './report.mjs';

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function readResults(path) {
  // A missing or malformed report must never become an empty, passing diff.
  if (!lstatSync(path).isFile()) throw new Error(`Not a regular results file: ${path}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return validateResults(data);
}

export function run(env = process.env, execute = spawnSync, binary) {
  const workspace = realpathSync(env.GITHUB_WORKSPACE);
  const results = realpathSync(env.OSV_RESULTS_DIRECTORY);
  if (!inside(realpathSync(env.RUNNER_TEMP), results) || results === workspace || inside(workspace, results)) {
    throw new Error('Results directory must be under RUNNER_TEMP and outside the checkout');
  }
  if ([workspace, results].some(path => /[\r\n]/.test(path))) throw new Error('Unsupported path');
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
    args = ['scan', 'source', '--format=json', `--output-file=${output}`,
      '--allow-no-lockfiles', '--no-call-analysis=go,rust', ...extra];
  } else {
    const oldData = readResults(join(results, 'old-results.json'));
    const newData = readResults(join(results, 'new-results.json'));
    for (const name of ['diff.json', 'results.sarif', 'summary.md']) rmSync(join(results, name), { force: true });
    const report = writeReport(results, diffResults(oldData, newData), workspace, failOnVuln === 'true');
    console.log(report.summary);
    for (const annotation of report.annotations) console.log(annotation);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.summary}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `vulnerabilities-found=${report.found}\n`);
    if (report.found && failOnVuln === 'true') throw new Error('New dependency vulnerabilities found');
    return report.found;
  }
  if (!binary || !isAbsolute(binary)) throw new Error('A verified absolute scanner binary path is required');
  // Use argument arrays and an explicit working directory on every platform.
  // No shell expansion, workflow tokens, or process-injection variables.
  const result = execute(binary, args, { cwd: workspace, env: { ...childEnvironment(env), GOTOOLCHAIN: 'auto' }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) throw new Error(`OSV scan failed (exit ${result.status}, signal ${result.signal})`);
  readResults(output);
  const found = result.status === 1;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `vulnerabilities-found=${found}\n`);
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const binary = (process.env.OSV_MODE || 'scan') === 'scan' ? await install() : undefined;
    run(process.env, spawnSync, binary);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
