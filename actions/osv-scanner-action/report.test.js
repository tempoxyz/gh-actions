const { test } = require('node:test');
const assert = require('node:assert/strict');
const result = (path = 'package-lock.json', version = '1', ids = ['TEST-1']) => ({ results: [{ source: { path, type: 'lockfile' }, packages: [{
  package: { name: 'example', ecosystem: 'npm', version },
  vulnerabilities: ids.map(id => ({ id, summary: 'Test vulnerability' })),
  groups: ids.map(id => ({ ids: [id], aliases: [id], max_severity: '8.0' })),
}] }] });

test('new findings fail while unchanged, removed, and relocated findings are baselined', async () => {
  const { diffResults } = await import('./report.mjs');
  assert.equal(diffResults({ results: null }, result()).results.length, 1);
  assert.deepEqual(diffResults(result(), result()), { results: [] });
  assert.deepEqual(diffResults(result(), { results: [] }), { results: [] });
  assert.deepEqual(diffResults(result(), result('moved/package-lock.json')), { results: [] });
  assert.deepEqual(diffResults(result(), result('package-lock.json', '2')), { results: [] });
  const diff = diffResults(result(), result('package-lock.json', '1', ['TEST-1', 'TEST-2']));
  assert.deepEqual(diff.results[0].packages[0].vulnerabilities.map(v => v.id), ['TEST-2']);
});

test('an additional vulnerable occurrence fails even if the advisory already existed', async () => {
  const { diffResults } = await import('./report.mjs');
  const after = { results: [...result().results, ...result('nested/package-lock.json').results] };
  const diff = diffResults(result(), after);
  assert.equal(diff.results.length, 1);
  assert.equal(diff.results[0].source.path, 'nested/package-lock.json');
});

test('normalizes Windows drive paths and POSIX paths and rejects outside-workspace locations', async () => {
  const { sourcePath } = await import('./report.mjs');
  assert.equal(sourcePath('D:\\a\\repo\\a space\\Cargo.lock', 'D:\\a\\repo'), 'a space/Cargo.lock');
  assert.equal(sourcePath('/repo/nested/Cargo.lock', '/repo'), 'nested/Cargo.lock');
  assert.equal(sourcePath('C:\\elsewhere\\Cargo.lock', 'D:\\a\\repo'), undefined);
  assert.equal(sourcePath('/elsewhere/Cargo.lock', '/repo'), undefined);
});

test('escapes hostile annotation and Markdown text and creates portable SARIF URIs', async () => {
  const { makeReport } = await import('./report.mjs');
  const data = result('D:\\a\\repo\\a space\\package-lock.json');
  data.results[0].packages[0].package.name = '<img>|\n::error::bad';
  data.results[0].packages[0].vulnerabilities[0].summary = 'bad\r\n::error::injected';
  const report = makeReport(data, 'D:\\a\\repo', false);
  assert.ok(report.summary.includes('&lt;img&gt;&#124;'));
  assert.ok(!report.annotations[0].includes('\n'));
  assert.ok(report.annotations[0].startsWith('::warning file='));
  assert.equal(report.sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, 'a%20space/package-lock.json');
});

test('malformed input never becomes a clean diff', async () => {
  const { diffResults } = await import('./report.mjs');
  assert.throws(() => diffResults({}, { results: [] }), /Invalid/);
  assert.throws(() => diffResults({ results: [] }, { results: [{ source: {}, packages: [] }] }), /Invalid/);
});
