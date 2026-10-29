const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/scan-github-actions.yml'), 'utf8');
const section = source.split('      - name: Validate scanner API access\n')[1].split('      - name: Mint read-only scanner token\n')[0];
const script = section.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
function accepts(eventName, event, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-auth-'));
  try {
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, JSON.stringify(event));
    return spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, API_SCOPE: 'tempoxyz/archon', API_POLICY: 'action-scan-read', EVENT_NAME: eventName, REPOSITORY_ID: '123', REF: 'refs/heads/main', GITHUB_EVENT_PATH: file, ...overrides },
      encoding: 'utf8',
    }).status === 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const upstream = { pull_request: { head: { repo: { id: 123, fork: false } } } };
test('allows upstream PRs and default-branch pushes', () => {
  assert.equal(accepts('pull_request', upstream), true);
  assert.equal(accepts('push', { repository: { default_branch: 'main' } }), true);
});
test('denies forks, missing heads, other events and nondefault pushes', () => {
  assert.equal(accepts('pull_request', { pull_request: { head: { repo: { id: 456, fork: true } } } }), false);
  assert.equal(accepts('pull_request', {}), false);
  assert.equal(accepts('pull_request_target', upstream), false);
  assert.equal(accepts('workflow_dispatch', {}), false);
  assert.equal(accepts('push', { repository: { default_branch: 'main' } }, { REF: 'refs/heads/other' }), false);
});
test('configuration is paired and absent inputs preserve existing callers', () => {
  assert.equal(accepts('pull_request', upstream, { API_SCOPE: '' }), false);
  assert.equal(accepts('pull_request', upstream, { API_POLICY: '' }), false);
  assert.equal(accepts('pull_request', {}, { API_SCOPE: '', API_POLICY: '' }), true);
});
test('keeps scanner credentials scoped and audits enabled', () => {
  assert.match(source, /ttl: 15m/);
  const scanners = source.split('      - name: Check action pin policy')[1].split('      - name: Install actionlint')[0];
  assert.equal((scanners.match(/inputs.github-api-scope == '' && github.token \|\| steps.audit-token.outputs.token/g) || []).length, 2);
  assert.match(scanners, /steps.audit-token.outcome == 'success'/);
  assert.match(scanners, /online-audits: true/);
  assert.match(source, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.doesNotMatch(source, /continue-on-error/);
});
