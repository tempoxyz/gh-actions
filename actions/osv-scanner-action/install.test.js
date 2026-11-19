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

test('retries transient SLSA verification failures with a per-attempt timeout', async () => {
  const { verifyProvenance, VERIFY_TIMEOUT_MS } = await import('./install.mjs');
  const delays = [];
  const calls = [];
  const results = [
    { error: Object.assign(new Error('spawnSync verifier ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null },
    { status: 1 },
    { status: 0 },
  ];
  await verifyProvenance('verifier', ['verify-artifact'], { cwd: '/tmp' }, {
    execute: (command, args, options) => { calls.push(options); return results.shift(); },
    sleep: async delay => delays.push(delay),
    log: () => {},
  });
  assert.equal(calls.length, 3);
  for (const options of calls) {
    assert.equal(options.timeout, VERIFY_TIMEOUT_MS);
    assert.equal(options.cwd, '/tmp');
  }
  assert.deepEqual(delays, [15_000, 45_000]);
});

test('workflow timeout covers verification retries for both scans with time for downloads and scanning', async () => {
  const { verifyProvenance, VERIFY_ATTEMPTS } = await import('./install.mjs');
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/dependency-scan.yml'), 'utf8');
  const timeoutMinutes = Number(workflow.match(/      timeout-minutes:\r?\n(?:        .*\r?\n)*?        default: (\d+)/)?.[1]);
  let verificationBudget = 0;
  // Each scan verifies the verifier and scanner, even when downloads are cached.
  for (let verification = 0; verification < 4; verification++) {
    let attempts = 0;
    await verifyProvenance('verifier', [], {}, {
      execute: (command, args, options) => {
        verificationBudget += options.timeout;
        return { status: ++attempts === VERIFY_ATTEMPTS ? 0 : 1 };
      },
      sleep: async delay => { verificationBudget += delay; },
      log: () => {},
    });
  }
  // Reserve ten minutes for downloads, scans, checkout, and reporting.
  assert.ok(timeoutMinutes * 60_000 >= verificationBudget + 10 * 60_000,
    `Workflow timeout ${timeoutMinutes}m must cover ${verificationBudget / 60_000}m of verification plus 10m`);
});

test('fails closed once every SLSA verification attempt fails', async () => {
  const { verifyProvenance, VERIFY_ATTEMPTS } = await import('./install.mjs');
  let calls = 0;
  await assert.rejects(
    verifyProvenance('verifier', [], {}, {
      execute: () => { calls += 1; return { status: 1 }; },
      sleep: async () => {},
      log: () => {},
    }),
    /exit 1/,
  );
  assert.equal(calls, VERIFY_ATTEMPTS);
});

test('does not retry a verifier that cannot be started', async () => {
  const { verifyProvenance } = await import('./install.mjs');
  let calls = 0;
  await assert.rejects(
    verifyProvenance('verifier', [], {}, {
      execute: () => { calls += 1; return { error: Object.assign(new Error('spawnSync verifier EACCES'), { code: 'EACCES' }), status: null }; },
      sleep: async () => assert.fail('permanent failure must not sleep'),
      log: () => {},
    }),
    /EACCES/,
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
