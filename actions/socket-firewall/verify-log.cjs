const assert = require("node:assert/strict");
const fs = require("node:fs");

const events = fs.readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));

for (const expected of [
  { purl: "pkg:npm/isnumber@1.0.0", action: "allow" },
  { purl: "pkg:npm/lodahs@0.0.1-security", action: "block" },
]) {
  assert.ok(
    events.some((event) => event.purl === expected.purl && event.action === expected.action),
    `Aegis log has no ${expected.action} decision for ${expected.purl}`,
  );
}
