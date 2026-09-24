const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('Jev routing and completion gate contracts', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', __dirname, '-p', 'test_*.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
