const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

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
