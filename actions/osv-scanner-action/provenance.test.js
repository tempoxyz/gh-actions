const { test } = require('node:test');
const assert = require('node:assert/strict');

test('provenance covers every platform binary pinned in releases.json', async () => {
  const { platformAssets } = await import('./provenance.mjs');
  const { releases } = await import('./install.mjs');
  const { scanners, verifiers } = platformAssets();
  assert.deepEqual(new Set(scanners), new Set(Object.keys(releases.scanner.assets).filter(n => n.startsWith('osv-scanner_') && !n.endsWith('SHA256SUMS'))));
  assert.deepEqual(new Set(verifiers), new Set(Object.keys(releases.verifier.assets).filter(n => !n.endsWith('.intoto.jsonl'))));
});

test('retries transient verifier failures and gives up on persistent ones', async () => {
  const { verifyWithRetry } = await import('./provenance.mjs');
  const delays = [];
  const statuses = [1, 0];
  verifyWithRetry('verifier', ['verify-artifact', 'bin'], {}, () => ({ status: statuses.shift() }), d => delays.push(d));
  assert.deepEqual(delays, [5_000]);

  let calls = 0;
  assert.throws(
    () => verifyWithRetry('verifier', ['verify-artifact', 'bin'], {}, () => { calls += 1; return { status: 1 }; }, () => {}),
    /SLSA verification failed for bin/,
  );
  assert.equal(calls, 3);
});
