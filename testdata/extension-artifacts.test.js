const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/tempo-extension.yml'), 'utf8');
const scripts = [...workflow.matchAll(/node <<'NODE'\n([\s\S]*?)\n          NODE/g)].map(match => match[1].replace(/^          /gm, ''));
const record = scripts.find(script => script.includes('fs.writeFileSync(`${output}.receipt.json`'));
const verify = scripts.find(script => script.includes('Artifact source mismatch'));
const publication = scripts.find(script => script.includes('fs.writeFileSync(`artifacts/${process.env.PACKAGE}-publication.receipt.json`'));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-recovery-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'artifacts'));
  for (const suffix of ['', '.sha256', '.spdx.json', '.sigstore.json']) fs.writeFileSync(path.join(directory, `artifacts/tempo-fixture-linux-amd64${suffix}`), `fixture${suffix}`);
  const env = { ...process.env, ARTIFACT_RUN_ID: '123', EXTENSION_OUTPUT: 'artifacts/tempo-fixture-linux-amd64', EXTENSION_PACKAGE: 'tempo-fixture', EXTENSION_VERSION: '0.18.0', GIT_DIR: childProcess.execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(), GITHUB_RUN_ID: '123', PACKAGE: 'tempo-fixture', TARGETS: 'linux-amd64', VERSION: '0.18.0' };
  function run(script) { return childProcess.spawnSync(process.execPath, ['-e', script], { cwd: directory, env, encoding: 'utf8' }); }
  assert.equal(run(record).status, 0);
  fs.writeFileSync(path.join(directory, 'artifacts/tempo-fixture-manifest.json'), 'original signed manifest');
  assert.equal(run(publication).status, 0);
  return { directory, env, run };
}

test('reuses receipts only when all immutable artifact bytes and identities match', context => {
  const saved = fixture(context);
  assert.equal(saved.run(verify).status, 0);
  fs.writeFileSync(path.join(saved.directory, 'artifacts/tempo-fixture-linux-amd64'), 'tampered');
  assert.notEqual(saved.run(verify).status, 0);
});

test('rejects other versions, producer runs, incomplete targets, and unexpected files', context => {
  const saved = fixture(context);
  saved.env.VERSION = '0.19.0';
  assert.notEqual(saved.run(verify).status, 0);
  saved.env.VERSION = '0.18.0';
  saved.env.ARTIFACT_RUN_ID = '124';
  assert.notEqual(saved.run(verify).status, 0);
  saved.env.ARTIFACT_RUN_ID = '123';
  saved.env.TARGETS = 'linux-amd64 linux-arm64';
  assert.notEqual(saved.run(verify).status, 0);
  saved.env.TARGETS = 'linux-amd64';
  fs.writeFileSync(path.join(saved.directory, 'artifacts/unexpected'), 'extra');
  assert.notEqual(saved.run(verify).status, 0);
});

test('rejects path traversal and missing required binary companions', context => {
  const saved = fixture(context);
  const file = path.join(saved.directory, 'artifacts/tempo-fixture-linux-amd64.receipt.json');
  const receipt = JSON.parse(fs.readFileSync(file));
  receipt.files['../other'] = 'a'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.notEqual(saved.run(verify).status, 0);
  delete receipt.files['../other'];
  delete receipt.files['tempo-fixture-linux-amd64.spdx.json'];
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.notEqual(saved.run(verify).status, 0);
});

test('recovery does not weaken conditional uploads or latest-pointer opt-out', () => {
  assert.ok(workflow.includes('--if-none-match'));
  assert.ok(workflow.includes('if [ "$PROMOTE_LATEST" = true ]; then'));
  assert.ok(workflow.includes('--signer-workflow tempoxyz/gh-actions/.github/workflows/tempo-extension.yml'));
});

test('requires the original signed publication and rejects changed manifest bytes', context => {
  const saved = fixture(context);
  const manifest = path.join(saved.directory, 'artifacts/tempo-fixture-manifest.json');
  fs.writeFileSync(manifest, 'new signature over the same binaries');
  assert.notEqual(saved.run(verify).status, 0);
  fs.writeFileSync(manifest, 'original signed manifest');
  assert.equal(saved.run(verify).status, 0);
  fs.unlinkSync(path.join(saved.directory, 'artifacts/tempo-fixture-publication.receipt.json'));
  assert.notEqual(saved.run(verify).status, 0);
  assert.ok(workflow.indexOf('name: Save complete signed publication') < workflow.indexOf('name: Upload to R2'));
});
