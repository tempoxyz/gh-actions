import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow, convertWorkflowTemplate, NoOperationTraceWriter, ErrorPolicy } from '../../actions/ensure-secure-runner/dist/workflow-parser.cjs';

// Execute the actual workflow's shell steps; only the network-facing commands
// are replaced. No Docker daemon, registry credentials, or Depot project needed.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const parsed = parseWorkflow({ name: 'repro.yml', content: readFileSync(join(repo, '.github/workflows/reproducible-image-verify.yml'), 'utf8') }, new NoOperationTraceWriter());
assert.deepEqual(parsed.context.errors.getErrors(), []);
const workflow = await convertWorkflowTemplate(parsed.context, parsed.value, undefined, { errorPolicy: ErrorPolicy.TryConversion });
assert.equal(workflow.errors?.length ?? 0, 0);
const step = (job, name) => workflow.jobs.find(j => j.id.value === job).steps.find(s => s.id === name || s.name?.value === name || s.name === name);
const digest = `sha256:${'a'.repeat(64)}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'repro-workflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const child of ['source', '.reproducible-verifier', 'bin']) mkdirSync(join(dir, child));
  writeFileSync(join(dir, 'payload'), 'reproducible bytes\n');
  writeFileSync(join(dir, 'output'), '');
  writeFileSync(join(dir, 'bin/docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in
  pull) [[ "\${PULL_FAIL:-0}" == 0 ]] ;;
  create) echo container-id ;;
  cp) [[ "\${COPY_FAIL:-0}" == 0 ]] && cp "$PAYLOAD" "$3" ;;
  rm) exit 0 ;;
  builder) [[ "$*" == 'builder prune --all --force' ]] ;;
  *) exit 42 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin/sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${dir}/bin:${process.env.PATH}`,
    GITHUB_WORKSPACE: dir,
    RUNNER_TEMP: dir,
    GITHUB_OUTPUT: join(dir, 'output'),
    CALL_LOG: join(dir, 'calls'),
    PAYLOAD: join(dir, 'payload'),
    COMMIT_SHA: '1'.repeat(40),
    VERIFIER_SHA: '2'.repeat(40),
    JOB_CONTEXT: JSON.stringify({ workflow_sha: '3'.repeat(40) }),
    SOURCE_DATE_EPOCH: '1234567890',
    CANDIDATE_REPOSITORY: 'ghcr.io/example/repro',
    CANDIDATE_TAG: 'run-123-1-abcdef0',
    CANDIDATE_DIGEST: digest,
    CLEAN_SHA256: sha256(readFileSync(join(dir, 'payload'))),
    BINARY_PATH: '/usr/local/bin/example',
    MANIFEST: join(dir, 'manifest.json'),
    BUILD_DEFINITIONS_SHA: '2'.repeat(40),
    BUILD_DEFINITION_PATHS: '.dockerignore\nscripts/build.sh\ndocker/bake.hcl',
    BUILD_SCRIPT: 'scripts/build.sh',
    BAKE_FILE: 'docker/bake.hcl',
    BAKE_TARGET: 'example-repro',
  };
  const run = (job, name, overrides = {}, cwd = join(dir, 'source')) => spawnSync('bash', ['-c', step(job, name).run.value], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' });
  const manifest = () => JSON.parse(readFileSync(env.MANIFEST, 'utf8'));
  return { dir, env, run, manifest };
}

function success(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

test('matching bytes pass and record immutable image/source/recipe/workflow identities', t => {
  const f = fixture(t);
  success(f.run('compare', 'compare'));
  const m = f.manifest();
  assert.equal(m.binary_comparison_result, 'success');
  assert.equal(m.depot_sha256, m.clean_build_sha256);
  assert.equal(m.failure, '');
  assert.equal(m.commit_sha, f.env.COMMIT_SHA);
  assert.equal(m.verifier_sha, f.env.VERIFIER_SHA);
  assert.equal(m.verification_workflow_sha, '3'.repeat(40));
  assert.equal(m.image_digest, digest);
  const calls = readFileSync(f.env.CALL_LOG, 'utf8');
  assert.ok(calls.includes(`pull ghcr.io/example/repro@${digest}`));
  assert.ok(calls.includes(`create ghcr.io/example/repro@${digest}`));
  assert.ok(calls.includes('rm -f container-id'));
  assert.ok(!calls.includes(f.env.CANDIDATE_TAG), 'extraction must never follow a mutable tag');
});

test('mismatched bytes produce a failure manifest and the gate fails', t => {
  const f = fixture(t);
  success(f.run('compare', 'compare', { CLEAN_SHA256: '0'.repeat(64) }));
  assert.equal(f.manifest().binary_comparison_result, 'failed');
  assert.match(f.manifest().failure, /does not match/);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /comparison_result=failed/);
  assert.equal(step('compare', 'Fail on checksum mismatch').if.expression, "success() && (steps.compare.outputs.comparison_result == 'failed')");
  assert.equal(f.run('compare', 'Fail on checksum mismatch', { IMAGE_DIGEST: digest, DEPOT_SHA256: f.env.CLEAN_SHA256 }).status, 1);
  assert.equal(step('compare', 'Upload verification manifest').if.expression, 'always()');
});

for (const [name, overrides, expected] of [
  ['invalid digest', { CANDIDATE_DIGEST: 'latest' }, /invalid candidate image digest/],
  ['registry unavailable', { PULL_FAIL: '1' }, /could not pull/],
  ['missing binary', { COPY_FAIL: '1' }, /did not complete/],
]) {
  test(`${name} fails and leaves diagnostic manifest`, t => {
    const f = fixture(t);
    assert.notEqual(f.run('compare', 'compare', overrides).status, 0);
    assert.equal(f.manifest().binary_comparison_result, 'failed');
    assert.match(f.manifest().failure, expected);
  });
}

for (const job of ['candidate', 'rebuild']) {
  test(`${job} overlays trusted files and retains executable mode`, t => {
    const f = fixture(t);
    const trusted = join(f.dir, '.reproducible-verifier');
    mkdirSync(join(trusted, 'scripts'));
    writeFileSync(join(trusted, 'scripts/build.sh'), '#!/bin/sh\necho trusted\n', { mode: 0o755 });
    success(f.run(job, 'Use trusted reproducible build definitions', { BUILD_DEFINITION_PATHS: 'scripts/build.sh\n' }));
    assert.match(readFileSync(join(f.dir, 'source/scripts/build.sh'), 'utf8'), /trusted/);
    assert.equal(statSync(join(f.dir, 'source/scripts/build.sh')).mode & 0o111, 0o111);
  });
  for (const path of ['../escape', '/tmp/escape', '.git/config', 'missing']) {
    test(`${job} rejects invalid or missing recipe ${path}`, t => {
      const f = fixture(t);
      assert.notEqual(f.run(job, 'Use trusted reproducible build definitions', { BUILD_DEFINITION_PATHS: path }).status, 0);
    });
  }
  test(`${job} rejects a symlink in the source tree`, t => {
    const f = fixture(t);
    mkdirSync(join(f.dir, '.reproducible-verifier/scripts'));
    writeFileSync(join(f.dir, '.reproducible-verifier/scripts/build.sh'), 'trusted');
    symlinkSync(join(f.dir, '.reproducible-verifier/scripts'), join(f.dir, 'source/scripts'));
    assert.notEqual(f.run(job, 'Use trusted reproducible build definitions', { BUILD_DEFINITION_PATHS: 'scripts/build.sh' }).status, 0);
  });
}

test('resolved source and trusted definitions remain distinct, and recipe list is enforced', t => {
  const f = fixture(t);
  success(f.run('resolve', 'commit', {}, repo));
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), /commit_sha=[0-9a-f]{40}/);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(`verifier_sha=${'2'.repeat(40)}`));
  assert.notEqual(f.run('resolve', 'commit', { BUILD_DEFINITIONS_SHA: 'main' }, repo).status, 0);
  assert.notEqual(f.run('resolve', 'commit', { BUILD_DEFINITION_PATHS: '.dockerignore' }, repo).status, 0);
  assert.notEqual(f.run('resolve', 'commit', { CANDIDATE_REPOSITORY: 'ghcr.io/example/repro:latest' }, repo).status, 0);
});

test('clean builder passes NO_CACHE and VERSION to the executable and hashes its output', t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'source/scripts'));
  writeFileSync(join(f.dir, 'source/scripts/build.sh'), '#!/usr/bin/env bash\nset -eu\n[[ "$NO_CACHE" == 1 && "$VERSION" == sha-abcdef0 ]]\nmkdir -p out\nprintf built > out/example\n', { mode: 0o755 });
  success(f.run('rebuild', 'Build reproducibly without Docker or BuildKit cache', { NO_CACHE: '1', VERSION: 'sha-abcdef0' }));
  success(f.run('rebuild', 'hash', { REBUILD_OUTPUT: 'out/example' }));
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(sha256('built')));
});

test('Depot receives the selected target and returns its digest; malformed metadata fails', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'bin/depot'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
printf '%s' "$DEPOT_METADATA" > "$RUNNER_TEMP/depot-bake-metadata.json"
`, { mode: 0o755 });
  const env = { DEPOT_PROJECT: 'example-project', CANDIDATE_IMAGE: 'ghcr.io/example/repro:run-123', DEPOT_METADATA: JSON.stringify({ 'example-repro': { 'containerimage.digest': digest } }) };
  success(f.run('candidate', 'bake', env));
  assert.ok(readFileSync(f.env.CALL_LOG, 'utf8').includes('--set example-repro.tags=ghcr.io/example/repro:run-123 example-repro'));
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), new RegExp(digest));
  for (const metadata of ['{}', '{"example-repro":{"containerimage.digest":"latest"}}']) {
    assert.notEqual(f.run('candidate', 'bake', { ...env, DEPOT_METADATA: metadata }).status, 0);
  }
});
