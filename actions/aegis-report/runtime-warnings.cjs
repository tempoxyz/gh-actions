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

// Splits pkg:type/name@version like the client, ignoring qualifiers and subpaths.
function packageVersion(purl) {
  if (typeof purl !== "string" || !purl.startsWith("pkg:")) return null;
  const slash = purl.indexOf("/");
  const identity = purl.slice(slash + 1).split(/[?#]/, 1)[0];
  const at = identity.lastIndexOf("@");
  if (slash <= 4 || at <= 0 || at === identity.length - 1) return null;
  return { type: purl.slice(4, slash), name: identity.slice(0, at), version: identity.slice(at + 1) };
}

// Matches the Aegis client's exception offer: a policy block that names
// recentlyPublished, either as a scan reason type or a blocking Socket alert.
function recentlyPublishedBlock(record) {
  if (record.category !== "policy" || !packageVersion(record.purl)) return false;
  const reasons = typeof record.reason === "string" ? record.reason.split(",").map((reason) => reason.trim()) : [];
  const alerts = Array.isArray(record.policy_alerts) ? record.policy_alerts : [];
  return reasons.includes("recentlyPublished")
    || alerts.some((alert) => alert?.type === "recentlyPublished" && alert?.action === "block");
}

async function scanRuntimeWarnings(file) {
  const counts = new Map();
  const recentlyPublished = new Set();
  let total = 0;
  let blocked = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    // Count decisions, not the separate lookup/attempt diagnostic records.
    if (!record || record.msg !== "package decision") continue;
    if (record.action === "block") {
      blocked += 1;
      if (recentlyPublishedBlock(record)) recentlyPublished.add(record.purl);
      continue;
    }
    if (record.action !== "warn") continue;
    total += 1;
    const reason = availabilityReasons.has(record.reason) ? record.reason : "other warning verdicts";
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return { total, counts, blocked, recentlyPublished: [...recentlyPublished] };
}

function runtimeWarningMessage({ total, counts }) {
  if (total === 0) return "";
  const reasons = [...counts].map(([reason, count]) => `${reason} (${count})`).join(", ");
  return `Aegis allowed ${total} package download${total === 1 ? "" : "s"} with warning verdicts: ${reasons}. Review the Aegis audit-log artifact for details.`;
}

// The policies page approves at most this many exemptions at once.
const EXEMPTION_LINK_PACKAGES = 50;
const LISTED_PACKAGES = 200;

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Package coordinates come from registry URLs; render them inertly.
function code(text) {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  const fence = "`".repeat(Math.max(0, ...(clean.match(/`+/g) || []).map((run) => run.length)) + 1);
  return `${fence}${clean.startsWith("`") || clean.endsWith("`") ? ` ${clean} ` : clean}${fence}`;
}

function packageLabel(purl) {
  const { type, name, version } = packageVersion(purl);
  return `${code(`${name.split("/").map(decode).join("/")}@${decode(version)}`)} (${code(decode(type))})`;
}

function exemptionUrl(purls) {
  const query = new URLSearchParams({ org: "*", repo: "*", reason: "recentlyPublished", verdict: "warn", confirm: "1" });
  for (const purl of purls) query.append("purl", purl);
  return `https://go/aegis/policies?${query}`;
}

// Lists each blocked package version and links to one policies-page dialog
// per batch, where a single Voight-Kampff approval adds Warn exemptions.
function recentlyPublishedSummary(purls) {
  if (!purls.length) return "";
  const lines = [
    `> 🕒 **Aegis blocked ${purls.length} recently published package version${purls.length === 1 ? "" : "s"}:**`,
    ">",
    ...purls.slice(0, LISTED_PACKAGES).map((purl) => `> - ${packageLabel(purl)}`),
  ];
  if (purls.length > LISTED_PACKAGES) lines.push(`> - …and ${purls.length - LISTED_PACKAGES} more in the Aegis audit-log artifact`);
  lines.push(">");
  for (let start = 0; start < purls.length; start += EXEMPTION_LINK_PACKAGES) {
    const batch = purls.slice(start, start + EXEMPTION_LINK_PACKAGES);
    const range = purls.length > EXEMPTION_LINK_PACKAGES ? ` (${start + 1}–${start + batch.length})` : "";
    lines.push(`> [Add Aegis exemptions for ${purls.length === 1 ? "this package" : "these packages"}${range}](${exemptionUrl(batch)})`);
  }
  lines.push(">", "> Each exemption downgrades recentlyPublished to a warning for that exact version only.");
  return lines.join("\n");
}

// Annotation messages are plain text; bare URLs are clickable in the run UI.
function recentlyPublishedAnnotation(purls) {
  if (!purls.length) return "";
  const lines = [
    `Aegis blocked ${purls.length} recently published package version${purls.length === 1 ? "" : "s"}:`,
    ...purls.slice(0, LISTED_PACKAGES).map((purl) => {
      const { type, name, version } = packageVersion(purl);
      return `- ${name.split("/").map(decode).join("/")}@${decode(version)} (${decode(type)})`
        .replace(/[\u0000-\u001f\u007f]/g, " ");
    }),
  ];
  if (purls.length > LISTED_PACKAGES) lines.push(`…and ${purls.length - LISTED_PACKAGES} more in the Aegis audit-log artifact.`);
  for (let start = 0; start < purls.length; start += EXEMPTION_LINK_PACKAGES) {
    const batch = purls.slice(start, start + EXEMPTION_LINK_PACKAGES);
    lines.push(`Add Aegis exemptions: ${exemptionUrl(batch)}`);
  }
  lines.push("Each exemption downgrades recentlyPublished to a warning for that exact version only.",
    "After approval, rerun failed jobs.");
  return lines.join("\n");
}

module.exports = { scanRuntimeWarnings, runtimeWarningMessage, recentlyPublishedSummary, recentlyPublishedAnnotation, exemptionUrl };
