// End-to-end native binary tests. Runs on Linux, macOS, and Windows in CI.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { install, assetNames, releases, childEnvironment } from './install.mjs';
import { run } from './run.mjs';

const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'osv native test '));
const source = join(root, 'source with spaces');
const results = join(root, 'results with spaces');
mkdirSync(source); mkdirSync(results);
const env = { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: source, OSV_RESULTS_DIRECTORY: results,
  GITHUB_OUTPUT: join(root, 'output.txt'), GITHUB_STEP_SUMMARY: join(root, 'summary.md') };
const binary = await install(env);
assert.equal(spawnSync(binary, ['--version'], { encoding: 'utf8' }).status, 0);
// A different repository must not be accepted even for a correctly signed artifact.
const names = assetNames();
const rejected = spawnSync(join(dirname(binary), names.verifier), ['verify-artifact', binary,
  '--provenance-path', join(dirname(binary), 'multiple.intoto.jsonl'),
  '--source-uri', 'github.com/tempoxyz/gh-actions', '--source-tag', releases.scanner.version],
{ env: childEnvironment(env), encoding: 'utf8' });
assert.equal(rejected.error, undefined);
assert.notEqual(rejected.status, 0, 'wrong provenance identity must fail');

const lockfile = join(source, 'package-lock.json');
function dependency(vulnerable) {
  writeFileSync(lockfile, JSON.stringify({ name: 'fixture', lockfileVersion: 3,
    packages: { '': { name: 'fixture' }, ...(vulnerable ? { 'node_modules/lodash': { version: '4.17.20' } } : {}) } }));
}
function scan(name, extra = {}) { return run({ ...env, OSV_RESULTS_FILE: name, ...extra }, spawnSync, binary); }
function report(fail = 'true') { return run({ ...env, OSV_MODE: 'report', OSV_FAIL_ON_VULN: fail }); }

dependency(false);
assert.equal(scan('old-results.json'), false, 'clean baseline');
copyFileSync(join(results, 'old-results.json'), join(root, 'clean.json'));
dependency(true);
assert.equal(scan('new-results.json'), true, 'known vulnerable dependency');
copyFileSync(join(results, 'new-results.json'), join(root, 'vulnerable.json'));
assert.throws(() => report(), /New dependency vulnerabilities/);
assert.equal(report('false'), true, 'warn-only retains findings');
assert.ok(readFileSync(env.GITHUB_OUTPUT, 'utf8').includes('vulnerabilities-found=true'));
assert.ok(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes('lodash'));
const sarif = JSON.parse(readFileSync(join(results, 'results.sarif')));
assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'package-lock.json');

copyFileSync(join(root, 'vulnerable.json'), join(results, 'old-results.json'));
assert.equal(report(), false, 'unchanged findings');
copyFileSync(join(root, 'clean.json'), join(results, 'new-results.json'));
assert.equal(report(), false, 'removed findings');
rmSync(lockfile);
assert.equal(scan('old-results.json'), false, 'no dependency files');
copyFileSync(join(root, 'vulnerable.json'), join(results, 'new-results.json'));
assert.throws(() => report(), /New dependency vulnerabilities/, 'first lockfile is still checked');
assert.equal(scan('new-results.json'), false);
assert.equal(report(), false, 'empty comparison');
assert.throws(() => scan('failed.json', { OSV_SCAN_ARGS: '--lockfile\nmissing.json', OSV_FAIL_ON_VULN: 'false' }), /failed/);
writeFileSync(lockfile, '{broken JSON');
assert.throws(() => scan('failed.json'), /failed/);
// Invalid reports are rejected even if they could otherwise hide findings.
writeFileSync(join(results, 'new-results.json'), '{}');
assert.throws(() => report('false'), /Invalid OSV results/);

// Reused downloads are checked again; a corrupt cached executable never runs.
writeFileSync(binary, 'corrupt cached binary');
await assert.rejects(install(env), /Checksum mismatch/);
rmSync(root, { recursive: true, force: true });
console.log(`PASS: native OSV integration (${process.platform}/${process.arch})`);
