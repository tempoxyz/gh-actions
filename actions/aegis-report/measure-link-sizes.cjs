// Synthetic coordinates measure transport capacity, not real package releases.
// Run: node actions/aegis-report/measure-link-sizes.cjs
const { createHash } = require("node:crypto");
const { deflateSync, gzipSync, inflateSync } = require("node:zlib");
const { exemptionUrl, recentlyPublishedAnnotation } = require("./runtime-warnings.cjs");
const { escapeAnnotation } = require("../harden-runner/annotations.cjs");

const base = "https://go/aegis/policies?org=*&repo=*&reason=recentlyPublished&verdict=warn&confirm=1";
const names = ["@openai/codex", "@typescript-eslint/parser", "@types/node", "@babel/core", "@esbuild/linux-x64",
  "eslint-plugin-import", "react-dom", "typescript", "@rollup/rollup-linux-x64-gnu", "@vitejs/plugin-react"];
const typical = Array.from({ length: 50 }, (_, i) => `pkg:npm/${names[i % names.length]}-${i}@${1 + i % 9}.${i % 12}.${i % 20}`);
const entropy = (seed, length) => Array.from({ length: Math.ceil(length / 64) }, (_, i) =>
  createHash("sha256").update(`${seed}-${i}`).digest("hex")).join("").slice(0, length);
const long = Array.from({ length: 50 }, (_, i) => `pkg:npm/${entropy(i, 512)}@${entropy(i + 50, 255)}`);
for (const [fixture, purls] of [
  ["thread: 2 versions", ["pkg:npm/@openai/codex@0.163.0", "pkg:npm/@openai/codex@0.163.0-linux-x64"]],
  ["typical: 10 versions", typical.slice(0, 10)], ["typical: 50 versions", typical], ["long: 50 versions", long],
]) {
  const json = JSON.stringify(purls);
  const raw = `${base}&${new URLSearchParams(purls.map(purl => ["purl", purl]))}`;
  const annotation = recentlyPublishedAnnotation(purls);
  const firstLink = annotation.match(/^Add Aegis exemptions: (\S+)$/m)?.[1];
  console.log(JSON.stringify({ fixture, rawUrl: raw.length,
    base64Url: `${base}&purls=${Buffer.from(json).toString("base64url")}`.length,
    gzipUrl: `${base}&purls=${gzipSync(json).toString("base64url")}`.length,
    deflateUrl: `${base}&purls=${deflateSync(json).toString("base64url")}`.length,
    selectedUrl: exemptionUrl(purls).length,
    firstLinkPackages: firstLink ? count(firstLink) : 0,
    annotationPackages: [...annotation.matchAll(/^Add Aegis exemptions: (\S+)$/gm)].reduce((sum, match) => sum + count(match[1]), 0),
    escapedAnnotation: escapeAnnotation(annotation).length,
  }));
}

function count(url) {
  const params = new URL(url).searchParams;
  return params.has("purls")
    ? JSON.parse(inflateSync(Buffer.from(params.get("purls"), "base64url"))).length
    : params.getAll("purl").length;
}
