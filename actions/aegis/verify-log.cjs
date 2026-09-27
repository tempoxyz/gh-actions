const assert = require("node:assert/strict");
const fs = require("node:fs");

const events = fs.readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));

const allowed = "pkg:npm/isnumber@1.0.0";
const blocked = "pkg:npm/lodahs@0.0.1-security";
const decision = (purl, action) => events.some(
  (event) => event.msg === "package decision" && event.purl === purl && event.action === action,
);
const noLookup = (purl) => events.some(
  (event) => event.msg === "socket lookup complete" && event.purl === purl &&
    event.action === "warn" && event.attempts === 0,
);
const offlineWarning = (purl) => events.some(
  (event) => event.msg === "package decision" && event.purl === purl &&
    event.action === "warn" && event.reason === "Not connected to internet" &&
    event.lookup?.result === "warn",
);

if (process.env.BLOCK_OUTCOME === "failure") {
  assert.ok(decision(allowed, "allow"), `Aegis log has no allow decision for ${allowed}`);
  assert.ok(decision(blocked, "block"), `Aegis log has no block decision for ${blocked}`);
} else if (process.env.RUNNER_OS === "Linux" && process.env.AEGIS_VERSION === "0.14.0" &&
    process.env.BLOCK_OUTCOME === "success" &&
    [allowed, blocked].every((purl) => offlineWarning(purl) && noLookup(purl))) {
  console.log("::warning title=Aegis v0.14.0 Linux fail-open::Both test packages were allowed without a Socket lookup because Aegis reported no internet connection. The netlink fix is merged but not yet released.");
} else {
  assert.fail(`Unexpected Aegis block outcome: ${process.env.BLOCK_OUTCOME || "missing"}`);
}
