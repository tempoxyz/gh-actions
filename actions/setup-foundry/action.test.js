const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const action = __dirname;
const asset = 'foundry_v1.8.1_linux_amd64.tar.gz';

// Replace only network/host boundaries; run the real installer, sha256sum,
// timeout, tar and filesystem operations against a small local archive.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'payload', 'runner']) fs.mkdirSync(path.join(root, dir));
  for (const name of ['forge', 'cast', 'anvil', 'chisel']) {
    fs.writeFileSync(path.join(root, 'payload', name), '#!/bin/sh\necho fixture\n');
  }
  const archive = path.join(root, asset);
  const packed = spawnSync('tar', ['-czf', archive, '-C', path.join(root, 'payload'), '.']);
  assert.equal(packed.status, 0, packed.stderr.toString());
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(root, 'checksum'), `${options.badChecksum ? '0'.repeat(64) : digest}  ${asset}\n`);
  fs.writeFileSync(path.join(root, 'options.json'), JSON.stringify(options));
  if (options.checksumText !== undefined) fs.writeFileSync(path.join(root, 'checksum'), options.checksumText);
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FIXTURE;
const options = JSON.parse(fs.readFileSync(path.join(root, 'options.json')));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({command, args}) + '\\n');
if (command === 'uname') { console.log(options.arch ?? 'x86_64'); process.exit(0); }
if (command === 'curl') {
  const name = args.at(-1).split('/').at(-1);
  const failure = options.failAsset === 'all' || options.failAsset === name;
  const destination = args[args.indexOf('-o') + 1];
  if (failure) {
    fs.writeFileSync(destination, 'partial-error-body');
    process.stdout.write(String(options.http ?? 504).padStart(3, '0') + ' ' + String(options.proxy ?? 0).padStart(3, '0'));
    process.exit(options.curlStatus ?? 22);
  }
  fs.copyFileSync(path.join(root, name.endsWith('.sha256') ? 'checksum' : '${asset}'), destination);
  process.stdout.write('200 200');
  process.exit(0);
}
if (command === 'gh') {
  if (args[0] === 'release') { console.log(options.resolvedTag ?? 'v1.8.1'); process.exit(0); }
  if (args[0] === 'attestation') { process.exit(options.attestationFailure ? 1 : 0); }
  if (args.some(x => x.includes('/releases/tags/'))) {
    if (options.metadataFailure) process.exit(1);
    if (options.ids !== undefined) { process.stdout.write(options.ids); process.exit(0); }
    console.log(args.at(-1).includes('.sha256') ? '102' : '101');
    process.exit(0);
  }
  if (options.apiFailure) { process.stdout.write('partial-api-body'); process.exit(options.apiExit ?? 1); }
  if (options.corruptApi) { process.stdout.write('corrupt-api-body'); process.exit(0); }
  process.stdout.write(fs.readFileSync(path.join(root, args.at(-1).endsWith('/102') ? 'checksum' : '${asset}')));
  process.exit(0);
}
process.exit(99);
`;
  for (const name of ['curl', 'gh', 'uname']) {
    fs.writeFileSync(path.join(root, 'bin', name), shim, { mode: 0o755 });
  }
  const env = { ...process.env, FIXTURE: root, PATH: `${root}/bin:${process.env.PATH}`,
    VERSION: options.version ?? 'v1.8.1', GH_HOST: 'untrusted.invalid', GITHUB_ACTION_PATH: action,
    RUNNER_TEMP: `${root}/runner`, GITHUB_PATH: `${root}/path`, GITHUB_OUTPUT: `${root}/output` };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const run = (script = 'install.sh', args = []) => spawnSync('bash', [path.join(action, script), ...args], { env, encoding: 'utf8', timeout: 10000 });
  const calls = () => fs.existsSync(`${root}/calls`) ? fs.readFileSync(`${root}/calls`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const assertNotPublished = () => {
    assert.equal(fs.existsSync(`${root}/path`), false);
    assert.equal(fs.existsSync(`${root}/output`), false);
    assert.equal(fs.existsSync(`${root}/runner/foundry-bin/forge`), false);
  };
  return { root, run, calls, assertNotPublished };
}

test('normal downloads retain checksum, tag and mandatory provenance verification', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(`${f.root}/output`, 'utf8'), 'tag=v1.8.1\n');
  const calls = f.calls();
  assert.equal(calls.filter(c => c.command === 'curl').length, 2);
  assert.equal(calls.filter(c => c.command === 'gh' && c.args[0] === 'api').length, 0);
  const verify = calls.find(c => c.command === 'gh' && c.args[0] === 'attestation');
  assert.deepEqual(verify.args.slice(3), ['--repo', 'foundry-rs/foundry', '--signer-workflow',
    'foundry-rs/foundry/.github/workflows/release.yml', '--source-ref', 'refs/tags/v1.8.1']);
  for (const c of calls.filter(c => c.command === 'curl')) {
    for (const [flag, value] of [['--connect-timeout', '10'], ['--max-time', '120'], ['--retry', '3'],
      ['--retry-max-time', '180'], ['--proto', '=https'], ['--proto-redir', '=https']]) {
      assert.equal(c.args[c.args.indexOf(flag) + 1], value);
    }
  }
});

for (const failAsset of [asset, asset.replace('.tar.gz', '.sha256'), 'all']) {
  test(`HTTP504 recovers ${failAsset} through exact asset IDs and still verifies`, t => {
    const f = fixture(t, { failAsset });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const metadata = calls.filter(c => c.args.some(x => x.includes('/releases/tags/')));
    assert.equal(metadata.length, failAsset === 'all' ? 2 : 1);
    for (const c of metadata) {
      assert.equal(c.args[3], 'repos/foundry-rs/foundry/releases/tags/v1.8.1');
      assert.deepEqual(c.args.slice(0, 3), ['api', '--hostname', 'github.com']);
      assert.match(c.args.at(-1), /^select\(\.tag_name == "v1\.8\.1" and \.draft == false\) \| \.assets\[\] \| select\(\.name == "foundry_v1\.8\.1_linux_amd64\.(tar\.gz|sha256)"\) \| \.id$/);
    }
    for (const c of calls.filter(c => c.args.some(x => x.includes('/releases/assets/')))) {
      assert.deepEqual(c.args.slice(0, 5), ['api', '--hostname', 'github.com', '-H', 'Accept: application/octet-stream']);
      assert.match(c.args.at(-1), /^repos\/foundry-rs\/foundry\/releases\/assets\/10[12]$/);
    }
    assert.equal(calls.filter(c => c.args[0] === 'attestation').length, 1);
    assert.deepEqual(fs.readFileSync(`${f.root}/runner/foundry-bin/${asset}`), fs.readFileSync(`${f.root}/${asset}`));
  });
}

for (const [curlStatus, http] of [[22, 403], [22, 404], [22, 410], [60, 0], [23, 200], [35, 0]]) {
  test(`permanent/security failure curl${curlStatus}/HTTP${http} does not use fallback`, t => {
    const f = fixture(t, { failAsset: 'all', curlStatus, http });
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls().some(c => c.command === 'gh'), false);
    f.assertNotPublished();
  });
}

for (const [curlStatus, http] of [[22, 429], [22, 503], [28, 0], [18, 200], [6, 0]]) {
  test(`transient failure curl${curlStatus}/HTTP${http} can recover`, t => {
    const f = fixture(t, { failAsset: asset, curlStatus, http });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const options of [{ ids: '' }, { ids: '101\n102\n' }, { ids: 'https://evil.invalid/' },
  { metadataFailure: true }, { apiFailure: true }, { apiFailure: true, apiExit: 124 }]) {
  test(`fallback fails closed for ${JSON.stringify(options)}`, t => {
    const f = fixture(t, { failAsset: asset, ...options });
    assert.notEqual(f.run().status, 0);
    f.assertNotPublished();
    assert.equal(fs.existsSync(`${f.root}/runner/foundry-bin/${asset}`), false);
    assert.deepEqual(fs.readdirSync(`${f.root}/runner/foundry-bin`), []);
    assert.equal(f.calls().some(c => c.args[0] === 'attestation'), false);
  });
}

for (const failAsset of [undefined, 'all']) for (const failure of ['badChecksum', 'attestationFailure']) {
  test(`${failure} after ${failAsset ?? 'normal'} download never exposes binaries or retries verification`, t => {
    const f = fixture(t, { failAsset, [failure]: true });
    assert.notEqual(f.run().status, 0);
    f.assertNotPublished();
    const calls = f.calls();
    assert.equal(calls.filter(c => c.command === 'curl').length, 2);
    assert.equal(calls.filter(c => c.args[0] === 'attestation').length, failure === 'badChecksum' ? 0 : 1);
    assert.equal(calls.filter(c => c.args.some(x => x.includes('/releases/assets/'))).length, failAsset ? 2 : 0);
  });
}

test('invalid release names are rejected before any request', t => {
  const f = fixture(t);
  assert.notEqual(f.run('download-release.sh', ['v1.8.1/other', asset, `${f.root}/result`]).status, 0);
  assert.notEqual(f.run('download-release.sh', ['v1.8.1', 'asset" | .other', `${f.root}/result`]).status, 0);
  assert.equal(f.calls().length, 0);
});

test('composite calls the tested installer and bounds both API requests', () => {
  assert.match(fs.readFileSync(path.join(action, 'action.yml'), 'utf8'), /run: bash "\$GITHUB_ACTION_PATH\/install.sh"/);
  const helper = fs.readFileSync(path.join(action, 'download-release.sh'), 'utf8');
  assert.match(helper, /timeout --kill-after=5s 30s gh api --hostname github.com/);
  assert.match(helper, /timeout --kill-after=5s 180s gh api --hostname github.com/);
});

for (const options of [{ curlStatus: 56, http: 0, proxy: 403 }, { curlStatus: 56, http: 0, proxy: 407 },
  { curlStatus: 56, http: 403 }, { curlStatus: 28, http: 401 }, { curlStatus: 18, http: 404 }]) {
  test(`transport status cannot hide an HTTP/proxy denial ${JSON.stringify(options)}`, t => {
    const f = fixture(t, { failAsset: asset, ...options });
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls().some(c => c.command === 'gh'), false);
    f.assertNotPublished();
  });
}

for (const options of [{ checksumText: '' }, { checksumText: 'not a digest' }, { failAsset: asset, corruptApi: true }]) {
  test(`malformed integrity input fails before provenance and extraction ${JSON.stringify(options)}`, t => {
    const f = fixture(t, options);
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls().some(c => c.args[0] === 'attestation'), false);
    f.assertNotPublished();
  });
}

for (const version of ['stable', 'nightly']) {
  test(`${version} keeps release resolution and source-ref semantics`, t => {
    const tag = version === 'stable' ? 'v1.8.1' : 'nightly-abc123';
    const f = fixture(t, { version, resolvedTag: tag, arch: 'aarch64' });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const label = version === 'stable' ? tag : 'nightly';
    assert.ok(calls.find(c => c.command === 'curl').args.at(-1).endsWith(`/foundry_${label}_linux_arm64.tar.gz`));
    assert.equal(calls.find(c => c.args[0] === 'attestation').args.at(-1), version === 'stable' ? `refs/tags/${tag}` : 'refs/heads/master');
    assert.equal(fs.readFileSync(`${f.root}/output`, 'utf8'), `tag=${tag}\n`);
  });
}
