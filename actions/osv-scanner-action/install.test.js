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

test('retries 5xx and 409 release downloads with exponential backoff', async t => {
  const { download } = await import('./install.mjs');
  const bytes = Buffer.from('trusted asset');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const delays = [];
  const statuses = [500, 409];
  const result = await download(
    { assets: { 'asset.bin': createHash('sha256').update(bytes).digest('hex') } },
    'asset.bin',
    directory,
    {
      fetch: async () => {
        const status = statuses.shift();
        return status === undefined
          ? { ok: true, arrayBuffer: async () => bytes }
          : { ok: false, status, headers: new Headers() };
      },
      sleep: async delay => delays.push(delay),
    },
  );

  assert.equal(result, path.join(directory, 'asset.bin'));
  assert.deepEqual(delays, [1_000, 2_000]);
});

test('honors Retry-After before retrying a rate-limited release download', async t => {
  const { download } = await import('./install.mjs');
  const bytes = Buffer.from('trusted asset');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const delays = [];
  let calls = 0;
  await download(
    { assets: { 'asset.bin': createHash('sha256').update(bytes).digest('hex') } },
    'asset.bin',
    directory,
    {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '3' }) }
          : { ok: true, arrayBuffer: async () => bytes };
      },
      sleep: async delay => delays.push(delay),
    },
  );

  assert.deepEqual(delays, [3_000]);
});

test('does not retry permanent release download failures', async t => {
  const { download } = await import('./install.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(
    download(
      { assets: { 'asset.bin': '0'.repeat(64) } },
      'asset.bin',
      directory,
      {
        fetch: async () => {
          calls += 1;
          return { ok: false, status: 404, headers: new Headers() };
        },
        sleep: async () => assert.fail('permanent failure must not sleep'),
      },
    ),
    /Download asset\.bin: HTTP 404/,
  );
  assert.equal(calls, 1);
});

test('native children receive platform necessities without tokens or injection variables', async () => {
  const { childEnvironment } = await import('./install.mjs');
  assert.deepEqual(childEnvironment({ Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', HOME: '/home/user',
    GITHUB_TOKEN: 'secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret', GH_TOKEN: 'secret', NODE_OPTIONS: '--require evil',
    LD_PRELOAD: 'evil', DYLD_INSERT_LIBRARIES: 'evil', GIT_CONFIG_COUNT: '1' }),
  { Path: 'C:\\tools', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', HOME: '/home/user' });
});
