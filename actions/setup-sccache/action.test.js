const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const action = __dirname;
const tag = 'v0.19.0';
const name = `sccache-${tag}-x86_64-unknown-linux-musl`;
const asset = `${name}.tar.gz`;
const vendor = path.resolve(action, '../../vendor/mozilla-actions/sccache-action');

// Replace only external network boundaries. Exercise real Bash, checksum verification,
// archive parsing, cache publication and the unchanged upstream setup/post bundles.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sccache-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', name, 'runner', 'tools']) fs.mkdirSync(path.join(root, dir));
  const stats = { stats: { compile_requests: 2, requests_executed: 2,
    cache_errors: { counts: {} }, cache_hits: { counts: { Rust: 1 } }, cache_misses: { counts: { Rust: 1 } },
    cache_write_errors: 0, cache_writes: 1, cache_write_duration: { secs: 0, nanos: 0 },
    cache_read_hit_duration: { secs: 0, nanos: 0 }, compiler_write_duration: { secs: 0, nanos: 0 } } };
  const binary = `#!/bin/sh\ncase "$*" in\n*--stats-format=json*) echo '${JSON.stringify(stats)}' ;;\n*) echo 'sccache fixture stats' ;;\nesac\n`;
  fs.writeFileSync(path.join(root, name, 'sccache'), binary);
  const packed = spawnSync('tar', ['-czf', path.join(root, asset), '-C', root, name]);
  assert.equal(packed.status, 0, packed.stderr.toString());
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, asset))).digest('hex');
  fs.writeFileSync(path.join(root, 'checksum'), options.checksumText ?? `${options.badChecksum ? '0'.repeat(64) : digest}\n`);
  fs.writeFileSync(path.join(root, 'options.json'), JSON.stringify(options));
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FIXTURE;
const options = JSON.parse(fs.readFileSync(path.join(root, 'options.json')));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ command, args }) + '\\n');
if (command === 'curl') {
  const filename = args.at(-1).split('/').at(-1);
  const destination = args[args.indexOf('-o') + 1];
  if (options.failAsset === 'all' || options.failAsset === filename) {
    fs.writeFileSync(destination, 'partial-error-body');
    process.stdout.write(String(options.http ?? 504).padStart(3, '0') + ' ' + String(options.proxy ?? 0).padStart(3, '0'));
    process.exit(options.curlStatus ?? 22);
  }
  fs.copyFileSync(path.join(root, filename.endsWith('.sha256') ? 'checksum' : '${asset}'), destination);
  process.stdout.write('200 200');
  process.exit(0);
}
if (args.includes('repos/mozilla/sccache/releases/latest')) { console.log(options.resolvedTag ?? '${tag}'); process.exit(0); }
if (args.some(x => x.includes('/releases/tags/'))) {
  if (options.metadataFailure) process.exit(1);
  if (options.ids !== undefined) { process.stdout.write(options.ids); process.exit(0); }
  console.log(args.at(-1).includes('.sha256') ? '102' : '101');
  process.exit(0);
}
fs.writeFileSync(path.join(root, 'api-pid'), String(process.pid));
if (options.apiStall) {
  if (options.ignoreTerm) process.on('SIGTERM', () => {});
  if (options.termExitZero) process.on('SIGTERM', () => process.exit(0));
  process.stdout.write('partial');
  setInterval(() => {}, 1000);
  return;
}
if (options.apiFailure) { process.stdout.write('partial'); process.exit(1); }
if (options.corruptApi) { process.stdout.write('corrupt'); process.exit(0); }
process.stdout.write(fs.readFileSync(path.join(root, args.at(-1).endsWith('/102') ? 'checksum' : '${asset}')));
`;
  for (const command of ['curl', 'gh']) fs.writeFileSync(path.join(root, 'bin', command), shim, { mode: 0o755 });
  let fixtureAction = action;
  if (options.shortWatchdog) {
    fixtureAction = path.join(root, 'action');
    fs.mkdirSync(fixtureAction);
    fs.copyFileSync(path.join(action, 'prepare.sh'), path.join(fixtureAction, 'prepare.sh'));
    fs.writeFileSync(path.join(fixtureAction, 'download-release.sh'), fs.readFileSync(path.join(action, 'download-release.sh'), 'utf8')
      .replace('SECONDS - progress_at >= 60', 'SECONDS - progress_at >= 2').replace('i < 5', 'i < 1'));
  }
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root,
    VERSION: options.version ?? tag, GH_HOST: 'untrusted.invalid', ACTION_PATH: fixtureAction,
    RUNNER_TEMP: `${root}/runner`, RUNNER_TOOL_CACHE: `${root}/tools`,
    GITHUB_PATH: `${root}/path`, GITHUB_ENV: `${root}/env`, GITHUB_OUTPUT: `${root}/output` };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const home = `${root}/tools/sccache/0.19.0/${process.arch}`;
  const run = () => spawnSync('bash', [path.join(fixtureAction, 'prepare.sh')], { env, encoding: 'utf8', timeout: 15000 });
  const calls = () => fs.existsSync(`${root}/calls`) ? fs.readFileSync(`${root}/calls`, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const notPublished = () => {
    assert.equal(fs.existsSync(`${home}.complete`), false);
    assert.equal(fs.existsSync(`${root}/output`), false);
    assert.equal(fs.existsSync(`${root}/path`), false);
    const parent = path.dirname(home);
    if (fs.existsSync(parent)) assert.equal(fs.readdirSync(parent).some(x => x.startsWith('.sccache.')), false);
  };
  return { root, run, calls, notPublished, env, home, binary };
}

for (const failAsset of [undefined, asset, `${asset}.sha256`, 'all']) {
  test(`verified installation with release transport ${failAsset ?? 'healthy'}`, t => {
    const f = fixture(t, { failAsset });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(`${f.home}/sccache`, 'utf8'), f.binary);
    assert.equal(fs.existsSync(`${f.home}.complete`), true);
    assert.equal(fs.readFileSync(`${f.root}/output`, 'utf8'), `version=${tag}\n`);
    const calls = f.calls();
    const metadata = calls.filter(c => c.args.some(x => x.includes('/releases/tags/')));
    assert.equal(metadata.length, !failAsset ? 0 : failAsset === 'all' ? 2 : 1);
    for (const c of metadata) {
      assert.deepEqual(c.args.slice(0, 4), ['api', '--hostname', 'github.com', `repos/mozilla/sccache/releases/tags/${tag}`]);
      assert.ok(c.args.at(-1).includes(`select(.tag_name == "${tag}" and .draft == false)`));
      assert.ok(c.args.at(-1).includes(`select(.name == "${asset}`));
    }
    for (const c of calls.filter(c => c.command === 'curl')) {
      for (const [flag, value] of [['--proto', '=https'], ['--proto-redir', '=https'], ['--connect-timeout', '10'], ['--speed-limit', '1024'], ['--speed-time', '60']])
        assert.equal(c.args[c.args.indexOf(flag) + 1], value);
    }
  });
}

for (const [curlStatus, http, proxy = 0] of [[22, 403], [22, 404], [22, 407], [60, 0], [35, 0], [47, 302], [23, 200], [56, 0, 403], [56, 0, 407], [28, 403], [18, 404]]) {
  test(`security/permanent refusal ${curlStatus}/${http}/${proxy}`, t => {
    const f = fixture(t, { failAsset: asset, curlStatus, http, proxy });
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls().some(c => c.command === 'gh'), false);
    f.notPublished();
  });
}
for (const [curlStatus, http] of [[22, 408], [22, 429], [22, 500], [22, 502], [22, 503], [6, 0], [7, 302], [18, 200], [28, 302], [52, 0], [55, 0], [56, 302]]) {
  test(`recoverable failure ${curlStatus}/${http}`, t => {
    const f = fixture(t, { failAsset: asset, curlStatus, http });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
  });
}
for (const options of [{ ids: '' }, { ids: '101\n102' }, { ids: '-1' }, { ids: 'https://evil.invalid' },
  { metadataFailure: true }, { apiFailure: true }, { corruptApi: true }]) {
  test(`fallback rejects ${JSON.stringify(options)}`, t => {
    const f = fixture(t, { failAsset: asset, ...options });
    assert.notEqual(f.run().status, 0);
    f.notPublished();
  });
}
for (const failAsset of [undefined, 'all']) for (const options of [{ badChecksum: true }, { checksumText: '' }, { checksumText: 'bad' }, { checksumText: 'a'.repeat(64) + '  another-file' }]) {
  test(`integrity failure cannot publish (${failAsset ?? 'primary'} ${JSON.stringify(options)})`, t => {
    const f = fixture(t, { failAsset, ...options });
    assert.notEqual(f.run().status, 0);
    f.notPublished();
    assert.equal(f.calls().filter(c => c.command === 'curl').length, 2);
  });
}
test('latest is resolved once then exact tag is passed to upstream', t => {
  const f = fixture(t, { version: '' });
  assert.equal(f.run().status, 0);
  assert.equal(f.calls().filter(c => c.args.includes('repos/mozilla/sccache/releases/latest')).length, 1);
  assert.equal(fs.readFileSync(`${f.root}/output`, 'utf8'), `version=${tag}\n`);
});
for (const version of ['latest', 'v0.19.0/../other', 'v0.19.0\nname=evil', 'v00.19.0', 'v0.19.0-rc..1', 'v0.19.0-01']) test(`invalid version ${JSON.stringify(version)}`, t => {
  const f = fixture(t, { version });
  assert.notEqual(f.run().status, 0);
  assert.equal(f.calls().length, 0);
  f.notPublished();
});
test('cache hit performs no downloads, upstream setup and post bundles retain their contract', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const count = f.calls().length;
  assert.equal(f.run().status, 0);
  assert.equal(f.calls().length, count);
  for (const file of ['path', 'env', 'summary']) fs.writeFileSync(`${f.root}/${file}`, '');
  const env = { ...f.env, INPUT_VERSION: tag, INPUT_DISABLE_ANNOTATIONS: 'false',
    ACTIONS_RUNTIME_TOKEN: 'fixture-runtime-token', ACTIONS_RESULTS_URL: 'https://cache.invalid/',
    GITHUB_STEP_SUMMARY: `${f.root}/summary`, SCCACHE_PATH: `${f.home}/sccache`, RUSTC_WRAPPER: 'sccache' };
  const setup = spawnSync(process.execPath, [path.join(vendor, 'dist/setup/index.js')], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.match(setup.stdout, /find sccache at:/);
  assert.ok(fs.readFileSync(`${f.root}/path`, 'utf8').includes(f.home));
  const exported = fs.readFileSync(`${f.root}/env`, 'utf8');
  for (const text of ['SCCACHE_PATH', `${f.home}/sccache`, 'ACTIONS_CACHE_SERVICE_V2', 'ACTIONS_RESULTS_URL', 'ACTIONS_RUNTIME_TOKEN']) assert.ok(exported.includes(text));
  const post = spawnSync(process.execPath, [path.join(vendor, 'dist/show_stats/index.js')], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(post.status, 0, post.stdout + post.stderr);
  assert.match(fs.readFileSync(`${f.root}/summary`, 'utf8'), /Cache hits/);
  assert.equal(f.calls().length, count);
  fs.writeFileSync(`${f.root}/summary`, '');
  const disabled = spawnSync(process.execPath, [path.join(vendor, 'dist/show_stats/index.js')], { env: { ...env, INPUT_DISABLE_ANNOTATIONS: 'true' }, encoding: 'utf8' });
  assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
  assert.equal(fs.readFileSync(`${f.root}/summary`, 'utf8'), '');
});
for (const options of [{}, { ignoreTerm: true }, { termExitZero: true }]) test(`API inactivity cleanup ${JSON.stringify(options)}`, t => {
  const f = fixture(t, { failAsset: asset, apiStall: true, shortWatchdog: true, ...options });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined);
  f.notPublished();
  const pid = Number(fs.readFileSync(`${f.root}/api-pid`, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('composite retains runner-managed post lifecycle and unchanged upstream version pin', () => {
  const manifest = fs.readFileSync(path.join(action, 'action.yml'), 'utf8');
  assert.match(manifest, /if: runner.os == 'Linux'/);
  assert.match(manifest, /uses: tempoxyz\/gh-actions\/vendor\/mozilla-actions\/sccache-action@68a1e4645c9596fee5398dd1e2ba07f0a4aa6a71/);
  assert.match(manifest, /disable_annotations: \$\{\{ inputs.disable_annotations \}\}/);
  assert.match(fs.readFileSync(path.join(vendor, 'action.yml'), 'utf8'), /post: "dist\/show_stats\/index.js"/);
});

test('reusable workflows embed exact current helpers and preserve upstream handoff', () => {
  const rendered = spawnSync(process.execPath, [path.join(action, 'render.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  for (const filename of ['rust-clippy.yml', 'rust-build-binaries.yml']) {
    const workflow = fs.readFileSync(path.resolve(action, '../../.github/workflows', filename), 'utf8');
    assert.match(workflow, /version: \$\{\{ steps.sccache-prepare.outputs.version \}\}/);
    assert.match(workflow, /RUSTC_WRAPPER: sccache/);
    assert.match(workflow, /sccache-action@68a1e4645c9596fee5398dd1e2ba07f0a4aa6a71/);
    const block = workflow.split('# BEGIN GENERATED sccache transport (actions/setup-sccache/render.mjs)\n')[1]
      .split('          # END GENERATED sccache transport')[0].split('\n').map(line => line.slice(10)).join('\n');
    assert.equal(spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' }).status, 0);
    assert.ok(!block.includes('ACTION_PATH'));
  }
});

test('incomplete existing cache fails without publishing a complete marker', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(`${f.home}/old`, 'incomplete');
  assert.notEqual(f.run().status, 0);
  f.notPublished();
  assert.equal(fs.readFileSync(`${f.home}/old`, 'utf8'), 'incomplete');
});
test('generated reusable workflow script runs without any action or consumer checkout path', t => {
  const f = fixture(t, { failAsset: 'all' });
  const workflow = fs.readFileSync(path.resolve(action, '../../.github/workflows/rust-clippy.yml'), 'utf8');
  const block = workflow.split('# BEGIN GENERATED sccache transport (actions/setup-sccache/render.mjs)\n')[1]
    .split('          # END GENERATED sccache transport')[0].split('\n').map(line => line.slice(10)).join('\n');
  const env = { ...f.env };
  delete env.ACTION_PATH;
  const result = spawnSync('bash', ['-c', block], { env, cwd: f.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(`${f.home}/sccache`, 'utf8'), f.binary);
});
test('a verified archive with a symlink executable cannot populate the cache', t => {
  const f = fixture(t);
  fs.unlinkSync(`${f.root}/${name}/sccache`);
  fs.symlinkSync('/bin/sh', `${f.root}/${name}/sccache`);
  assert.equal(spawnSync('tar', ['-czf', `${f.root}/${asset}`, '-C', f.root, name]).status, 0);
  fs.writeFileSync(`${f.root}/checksum`, createHash('sha256').update(fs.readFileSync(`${f.root}/${asset}`)).digest('hex'));
  assert.notEqual(f.run().status, 0);
  f.notPublished();
});
