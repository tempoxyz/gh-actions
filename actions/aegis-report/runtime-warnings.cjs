const fs = require("node:fs");
const readline = require("node:readline");

// Only client-owned, fixed strings are included in annotations. Policy reasons
// can contain upstream text, so those are counted without quoting them.
const availabilityReasons = new Set([
  "Not connected to internet",
  "Not connected to Tailscale",
  "Aegis server unreachable",
  "Aegis server unavailable",
  "Aegis server timed out",
  "Rate limited by Aegis server",
  "Client error communicating with Aegis server",
]);

async function scanRuntimeWarnings(file) {
  const counts = new Map();
  let total = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Count decisions, not the separate lookup/attempt diagnostic records.
    if (!record || record.msg !== "package decision" || record.action !== "warn") continue;
    total += 1;
    const reason = availabilityReasons.has(record.reason) ? record.reason : "other warning verdicts";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return { total, counts };
}

function runtimeWarningMessage({ total, counts }) {
  if (total === 0) return "";
  const reasons = [...counts].map(([reason, count]) => `${reason} (${count})`).join(", ");
  return `Aegis allowed ${total} package download${total === 1 ? "" : "s"} with warning verdicts: ${reasons}. Review the Aegis audit-log artifact for details.`;
}

module.exports = { scanRuntimeWarnings, runtimeWarningMessage };
