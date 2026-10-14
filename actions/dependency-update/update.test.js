const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

for (const directory of ["amp-repair", "dependency-update"]) {
  test(`${directory}: Python regression tests`, () => {
    const source = path.resolve(__dirname, "..", directory);
    const result = spawnSync("python3", ["-m", "unittest", "discover", "-s", source, "-v"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 120000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
