const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
  const { run } = await import('./run.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const results = path.join(root, 'results');
  fs.mkdirSync(source); fs.mkdirSync(results);
  const env = { GITHUB_WORKSPACE: source, RUNNER_TEMP: root, OSV_RESULTS_DIRECTORY: results };
  const write = (name, data = { results: [] }) => fs.writeFileSync(path.join(results, name), JSON.stringify(data));
  return { run, env, results, source, write };
}

test('scan preserves argument boundaries, isolates source, and accepts findings for comparison', async t => {
  const f = await fixture(t);
  f.env.OSV_SCAN_ARGS = '--lockfile\na path/package-lock.json';
  const found = f.run(f.env, (command, args) => {
    assert.equal(command, 'docker');
    assert.ok(args.includes(`type=bind,source=${fs.realpathSync(f.source)},target=/github/workspace,readonly`));
    assert.ok(args.includes('a path/package-lock.json'));
    assert.ok(args.includes('/root/osv-scanner'));
    assert.ok(!args.some(arg => arg.includes('GITHUB_TOKEN')));
    f.write('results.json');
    return { status: 1 };
  });
  assert.equal(found, true);
});

test('scanner operational errors fail even with partial results and fail-on-vuln disabled', async t => {
  const f = await fixture(t);
  f.env.OSV_FAIL_ON_VULN = 'false';
  assert.throws(() => f.run(f.env, () => {
    f.write('results.json');
    return { status: 2 };
  }), /failed/);
});

test('successful exit without fresh results fails, including a stale passing report', async t => {
  const f = await fixture(t);
  f.write('results.json');
  assert.throws(() => f.run(f.env, () => ({ status: 0 })), /ENOENT/);
});

test('invalid JSON or result schema fails', async t => {
  const f = await fixture(t);
  assert.throws(() => f.run(f.env, () => {
    f.write('results.json', {});
    return { status: 0 };
  }), /Invalid OSV results/);
});

test('report refuses a missing or malformed input before launching the reporter', async t => {
  const f = await fixture(t);
  f.env.OSV_MODE = 'report';
  f.write('old-results.json');
  const never = () => assert.fail('reporter must not run');
  assert.throws(() => f.run(f.env, never), /ENOENT/);
  f.write('new-results.json', {});
  assert.throws(() => f.run(f.env, never), /Invalid OSV results/);
});

test('report blocks new vulnerabilities and supports an explicit warn-only mode', async t => {
  const f = await fixture(t);
  f.env.OSV_MODE = 'report';
  f.write('old-results.json'); f.write('new-results.json');
  const report = () => { f.write('diff.json'); return { status: 1 }; };
  assert.throws(() => f.run(f.env, report), /New dependency vulnerabilities/);
  f.env.OSV_FAIL_ON_VULN = 'false';
  assert.equal(f.run(f.env, report), true);
});

test('rejects source-controlled results, escaping filenames and output overrides', async t => {
  const f = await fixture(t);
  const never = () => assert.fail('container must not run');
  assert.throws(() => f.run({ ...f.env, OSV_RESULTS_DIRECTORY: f.source }, never), /outside the checkout/);
  assert.throws(() => f.run({ ...f.env, OSV_RESULTS_FILE: '../escape.json' }, never), /simple JSON/);
  assert.throws(() => f.run({ ...f.env, OSV_SCAN_ARGS: '--output-file=other.json' }, never), /managed by the action/);
});

test('accepts the null results emitted by OSV for an empty inventory or clean diff', async t => {
  const f = await fixture(t);
  assert.equal(f.run(f.env, () => {
    f.write('results.json', { results: null });
    return { status: 0 };
  }), false);
});
