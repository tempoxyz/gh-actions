const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '../..');

test('installer smoke tests execute the checked-out candidates', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
  for (const [name, count] of [['setup-mold', 2], ['scan-github-actions', 2], ['setup-pinact', 1], ['actionlint', 1]]) {
    const references = workflow.split('\n').filter(line => line.includes('uses:') && line.includes(`/actions/${name}`));
    assert.equal(references.length, count, name);
    for (const reference of references) assert.ok(reference.includes(`uses: ./actions/${name} #`), reference);
  }
});

test('scanner CI executes the candidate reusable workflow without weakening its policy', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/scan-github-actions-ci.yml'), 'utf8');
  assert.match(workflow, /uses: \.\/.github\/workflows\/scan-github-actions.yml #/);
  assert.match(workflow, /pinact: true/);
  assert.match(workflow, /verify-pin-comments: true/);
});
