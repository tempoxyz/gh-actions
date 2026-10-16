const fs = require("node:fs");
const readline = require("node:readline");
const { deflateSync } = require("node:zlib");
const { escapeAnnotation } = require("../harden-runner/annotations.cjs");

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
const LISTED_PACKAGES = 50;
const ANNOTATION_PACKAGES = 5;
// Leave room for instructions and the workflow-command title under 4096 chars.
const ANNOTATION_MESSAGE_LIMIT = 4000;
const EXEMPTION_URL_LIMIT = 3500;
// Match the policies page's bounded decompression budget.
const EXEMPTION_PAYLOAD_LIMIT = 32 * 1024;

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
  const plain = `https://go/aegis/policies?${query}`;
  query.delete("purl");
  query.set("purls", deflateSync(JSON.stringify(purls)).toString("base64url"));
  const packed = `https://go/aegis/policies?${query}`;
  return packed.length < plain.length ? packed : plain;
}

// Split on count and encoded size, never by cutting a URL or package coordinate.
function exemptionBatches(purls) {
  const batches = [];
  for (let start = 0; start < purls.length;) {
    const batch = purls.slice(start, start + EXEMPTION_LINK_PACKAGES);
    let url;
    while (true) {
      url = exemptionUrl(batch);
      if (url.length <= EXEMPTION_URL_LIMIT && Buffer.byteLength(JSON.stringify(batch)) <= EXEMPTION_PAYLOAD_LIMIT) break;
      if (batch.length === 1) { url = ""; break; }
      batch.pop();
    }
    batches.push({ start, count: batch.length, url });
    start += batch.length;
  }
  return batches;
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
  const batches = exemptionBatches(purls);
  for (const { start, count, url } of batches) {
    const range = batches.length > 1 ? ` (${start + 1}–${start + count})` : "";
    lines.push(url
      ? `> [Add Aegis exemptions for ${purls.length === 1 ? "this package" : "these packages"}${range}](${url})`
      : `> Package ${start + 1} is too large for an exemption link; use the Aegis policies page and audit-log artifact.`);
  }
  lines.push(">", "> Each exemption downgrades recentlyPublished to a warning for that exact version only.");
  return lines.join("\n");
}

// Bare URLs are clickable. Budget the escaped form too, so runner truncation
// cannot turn a complete exemption link into a partial package selection.
function recentlyPublishedAnnotation(purls) {
  if (!purls.length) return "";
  const lines = [`Aegis blocked ${purls.length} recently published package version${purls.length === 1 ? "" : "s"}:`];
  const footer = ["Each exemption downgrades recentlyPublished to a warning for that exact version only.",
    "After approval, rerun failed jobs. See the step summary for all packages and exemption links."];
  const fits = candidate => escapeAnnotation([...candidate, ...footer].join("\n")).length <= ANNOTATION_MESSAGE_LIMIT;
  for (const { url } of exemptionBatches(purls)) {
    if (!url || !fits([...lines, `Add Aegis exemptions: ${url}`])) break;
    lines.push(`Add Aegis exemptions: ${url}`);
  }
  for (const purl of purls.slice(0, ANNOTATION_PACKAGES)) {
    const { type, name, version } = packageVersion(purl);
    const label = `- ${name.split("/").map(decode).join("/")}@${decode(version)} (${decode(type)})`
      .replace(/[\u0000-\u001f\u007f]/g, " ");
    if (!fits([...lines, label])) break;
    lines.push(label);
  }
  return [...lines, ...footer].join("\n");
}

module.exports = { scanRuntimeWarnings, runtimeWarningMessage, recentlyPublishedSummary, recentlyPublishedAnnotation, exemptionUrl };
