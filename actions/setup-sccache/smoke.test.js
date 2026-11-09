const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('CI exercises the candidate wrapper and its runner-managed post action', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/test.yml'), 'utf8');
  const job = workflow.match(/^  setup-sccache-download:\n[\s\S]*?(?=^  \S)/m)?.[0];
  assert.ok(job);
  assert.match(job, /uses: \.\/actions\/setup-sccache #/);
  assert.match(job, /version: v0\.19\.0/);
  assert.match(job, /sccache --version/);
  assert.match(job, /sccache --show-stats/);
});
