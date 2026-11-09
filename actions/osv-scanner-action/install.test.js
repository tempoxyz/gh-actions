const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('resolves all six supported OS/architecture binaries and pinned provenance', async () => {
  const { assetNames, releases } = await import('./install.mjs');
  for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
    const names = assetNames(platform, arch);
    for (const kind of ['scanner', 'verifier']) {
      assert.match(releases[kind].assets[names[kind]], /^[a-f0-9]{64}$/);
      assert.equal(names[kind].endsWith('.exe'), platform === 'win32');
    }
    assert.match(releases.verifier.assets[`${names.verifier}.intoto.jsonl`], /^[a-f0-9]{64}$/);
  }
  assert.match(releases.scanner.assets['multiple.intoto.jsonl'], /^[a-f0-9]{64}$/);
  assert.throws(() => assetNames('freebsd', 'x64'), /Unsupported/);
  assert.throws(() => assetNames('linux', 'ia32'), /Unsupported/);
});

test('rejects a modified download before it can be executed', async () => {
  const { verifyChecksum } = await import('./install.mjs');
  const bytes = Buffer.from('trusted binary');
  const digest = createHash('sha256').update(bytes).digest('hex');
  verifyChecksum(bytes, digest, 'scanner');
  assert.throws(() => verifyChecksum(Buffer.from('modified binary'), digest, 'scanner'), /Checksum mismatch/);
});

test('native children receive platform necessities without tokens or injection variables', async () => {
  const { childEnvironment } = await import('./install.mjs');
  assert.deepEqual(childEnvironment({ Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', HOME: '/home/user',
    GITHUB_TOKEN: 'secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret', GH_TOKEN: 'secret', NODE_OPTIONS: '--require evil',
    LD_PRELOAD: 'evil', DYLD_INSERT_LIBRARIES: 'evil', GIT_CONFIG_COUNT: '1' }),
  { Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', HOME: '/home/user' });
});

test('self-verification precedes scanner verification, and either failure blocks installation', async t => {
  const { install, assetNames, releases } = await import('./install.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osv verification '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const names = assetNames();
  const directory = path.join(root, `tempo-osv-${releases.scanner.version}-${releases.verifier.version}-${process.platform}-${process.arch}`);
  fs.mkdirSync(directory);
  const original = structuredClone(releases);
  t.after(() => Object.assign(releases, original));
  // Local fixtures stand in for checksum-pinned bytes; only the subprocess boundary is intercepted.
  function seed() {
    for (const [release, name] of [[releases.scanner, names.scanner], [releases.verifier, names.verifier],
      [releases.scanner, 'multiple.intoto.jsonl'], [releases.verifier, `${names.verifier}.intoto.jsonl`]]) {
      const bytes = Buffer.from(name);
      release.assets[name] = createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(directory, name), bytes);
    }
  }
  for (const failure of [0, 1, -1]) {
    seed(); const calls = [];
    const invoke = install({ RUNNER_TEMP: root, GITHUB_TOKEN: 'secret', NODE_OPTIONS: '--require evil' }, (binary, args, options) => {
      calls.push({ binary, args, options });
      return { status: calls.length - 1 === failure ? 1 : 0 };
    });
    if (failure >= 0) {
      await assert.rejects(invoke, /SLSA verification failed/);
      assert.equal(fs.existsSync(path.join(directory, names.scanner)), false);
    } else assert.equal(await invoke, path.join(directory, names.scanner));
    assert.equal(calls.length, failure === 0 ? 1 : 2);
    for (const [index, call] of calls.entries()) {
      const release = index === 0 ? releases.verifier : releases.scanner;
      const artifact = index === 0 ? names.verifier : names.scanner;
      const provenance = index === 0 ? `${names.verifier}.intoto.jsonl` : 'multiple.intoto.jsonl';
      assert.equal(call.binary, path.join(directory, names.verifier));
      assert.deepEqual(call.args, ['verify-artifact', path.join(directory, artifact), '--provenance-path',
        path.join(directory, provenance), '--source-uri', `github.com/${release.repository}`, '--source-tag', release.version]);
      assert.deepEqual(call.options.env, {});
    }
  }
});
