const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.join(__dirname, 'ensure-gh.sh');
const sourceRef = 'refs/heads/bagtoad/go-1-27-3-patch-on-v2-102-0';
const workflow = 'cli/cli/.github/workflows/deployment.yml';
const digests = {
  amd64: '77b9e297e94c50336823d0f84de7ef1be60cba704601fa0d98f129f47a94987b',
  arm64: '5019b3cc6e8a03bb4d88600f8dbda2add8e6407705c159b0c63151036e77a1af',
};

// Run the unchanged bootstrap script with isolated PATH and a real tar archive.
// Network/provenance are fixture boundaries. Translate the pinned digest to the
// fixture digest only after asserting the pin, then use the real sha256sum.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-gh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const arch = ['aarch64', 'arm64'].includes(options.arch) ? 'arm64' : 'amd64';
  const asset = `gh_2.102.1_linux_${arch}.tar.gz`;
  for (const dir of ['bin', 'runner', `gh_2.102.1_linux_${arch}/bin`]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const resolve = name => {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commands = Object.fromEntries(['bash', 'mktemp', 'gzip', 'tar', 'sha256sum'].map(name => [name, resolve(name)]));
  for (const name of ['bash', 'mktemp', 'gzip']) fs.symlinkSync(commands[name], path.join(root, 'bin', name));
  const verifier = `#!${process.execPath}
const fs = require('node:fs');
const root = process.env.FIXTURE;
const options = JSON.parse(fs.readFileSync(root + '/options.json'));
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls', JSON.stringify({command: 'downloaded-gh', args}) + '\\n');
if (args[0] === '--version') { console.log('gh version 2.102.1'); process.exit(0); }
const assert = require('node:assert/strict');
assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
assert.deepEqual(args.slice(3), ['--repo', 'cli/cli', '--signer-workflow', ${JSON.stringify(workflow)}, '--source-ref', ${JSON.stringify(sourceRef)}]);
const value = flag => args[args.indexOf(flag) + 1];
if (options.provenanceFailure ||
    value('--repo') !== (options.publisher ?? 'cli/cli') ||
    value('--signer-workflow') !== (options.workflow ?? ${JSON.stringify(workflow)}) ||
    value('--source-ref') !== (options.sourceRef ?? ${JSON.stringify(sourceRef)})) process.exit(1);
`;
  fs.writeFileSync(path.join(root, `gh_2.102.1_linux_${arch}/bin/gh`), verifier, { mode: 0o755 });
  const archive = path.join(root, asset);
  const packed = spawnSync(commands.tar, ['-czf', archive, '-C', root, `gh_2.102.1_linux_${arch}/bin/gh`]);
  assert.equal(packed.status, 0, packed.stderr.toString());
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(root, 'options.json'), JSON.stringify(options));
  const shim = `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.FIXTURE;
const options = JSON.parse(fs.readFileSync(root + '/options.json'));
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
fs.appendFileSync(root + '/calls', JSON.stringify({command, args}) + '\\n');
if (command === 'uname') {
  console.log(args[0] === '-s' ? (options.os ?? 'Linux') : (options.arch ?? 'x86_64'));
} else if (command === 'gh') {
  assert.deepEqual(args, ['attestation', 'verify', '--help']);
  console.log(options.help ?? '--signer-workflow --source-ref');
  process.exit(options.helpStatus ?? 0);
} else if (command === 'curl') {
  assert.equal(args.at(-1), 'https://github.com/cli/cli/releases/download/v2.102.1/${asset}');
  const output = args[args.indexOf('-o') + 1];
  if (options.downloadFailure) process.exit(22);
  if (options.corruptArchive) fs.writeFileSync(output, 'corrupt archive');
  else fs.copyFileSync(root + '/${asset}', output);
} else if (command === 'sha256sum') {
  assert.deepEqual(args, ['--check', '--strict']);
  const input = fs.readFileSync(0, 'utf8');
  assert.ok(input.startsWith('${digests[arch]}  '), 'release checksum pin changed');
  const result = spawnSync(${JSON.stringify(commands.sha256sum)}, args, {
    input: input.replace('${digests[arch]}', '${digest}'), encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status);
} else if (command === 'tar') {
  const result = spawnSync(${JSON.stringify(commands.tar)}, args, { stdio: 'inherit' });
  process.exit(result.status);
} else process.exit(99);
`;
  for (const name of ['uname', 'curl', 'sha256sum', 'tar', ...(options.existingGh ? ['gh'] : [])]) {
    fs.writeFileSync(path.join(root, 'bin', name), shim, { mode: 0o755 });
  }
  const env = { FIXTURE: root, PATH: path.join(root, 'bin'), RUNNER_TEMP: path.join(root, 'runner'), GITHUB_PATH: path.join(root, 'path') };
  const run = () => spawnSync(commands.bash, [script], { env, encoding: 'utf8', timeout: 10000 });
  const calls = () => fs.existsSync(path.join(root, 'calls'))
    ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const assertNotPublished = () => assert.equal(fs.existsSync(path.join(root, 'path')), false);
  return { root, run, calls, assertNotPublished };
}

for (const arch of ['x86_64', 'aarch64', 'arm64']) {
  test(`bootstrap ${arch} enforces pinned publisher, workflow and release source`, t => {
    const f = fixture(t, { arch });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.deepEqual(calls.map(c => c.command), ['uname', 'uname', 'curl', 'sha256sum', 'tar', 'downloaded-gh', 'downloaded-gh']);
    assert.deepEqual(calls.at(-2).args.slice(3), ['--repo', 'cli/cli', '--signer-workflow', workflow, '--source-ref', sourceRef]);
    assert.deepEqual(calls.at(-1).args, ['--version']);
    const published = fs.readFileSync(path.join(f.root, 'path'), 'utf8').trim();
    assert.ok(published.startsWith(path.join(f.root, 'runner', 'foundry-gh.')));
    assert.equal(fs.existsSync(path.join(published, 'gh')), true);
  });
}

for (const [name, options] of [
  ['wrong publisher', { publisher: 'attacker/cli' }],
  ['wrong workflow', { workflow: 'cli/cli/.github/workflows/other.yml' }],
  ['wrong source', { sourceRef: 'refs/heads/trunk' }],
  ['untrusted provenance', { provenanceFailure: true }],
]) {
  test(`${name} prevents PATH publication and version execution`, t => {
    const f = fixture(t, options);
    assert.notEqual(f.run().status, 0);
    f.assertNotPublished();
    const executions = f.calls().filter(c => c.command === 'downloaded-gh');
    assert.equal(executions.length, 1);
    assert.equal(executions[0].args[0], 'attestation');
  });
}

test('checksum mismatch stops before extraction or downloaded code execution', t => {
  const f = fixture(t, { corruptArchive: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /FAILED/);
  assert.equal(f.calls().some(c => ['tar', 'downloaded-gh'].includes(c.command)), false);
  f.assertNotPublished();
});

test('download failure stops before checksum or downloaded code execution', t => {
  const f = fixture(t, { downloadFailure: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(f.calls().some(c => ['sha256sum', 'tar', 'downloaded-gh'].includes(c.command)), false);
  f.assertNotPublished();
});

test('compatible existing gh is reused without downloading or changing PATH', t => {
  const f = fixture(t, { existingGh: true, os: 'Darwin' });
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls(), [{ command: 'gh', args: ['attestation', 'verify', '--help'] }]);
  f.assertNotPublished();
});

for (const help of ['', '--signer-workflow', '--source-ref']) {
  test(`incompatible existing gh (${help || 'no flags'}) triggers bootstrap`, t => {
    const f = fixture(t, { existingGh: true, help });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().filter(c => c.command === 'curl').length, 1);
    assert.equal(f.calls().filter(c => c.command === 'downloaded-gh').length, 2);
  });
}

for (const options of [{ os: 'Darwin' }, { arch: 'riscv64' }]) {
  test(`unsupported host ${JSON.stringify(options)} fails without a download`, t => {
    const f = fixture(t, options);
    assert.notEqual(f.run().status, 0);
    assert.equal(f.calls().some(c => c.command === 'curl'), false);
    f.assertNotPublished();
  });
}
