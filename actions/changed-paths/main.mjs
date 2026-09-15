import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { evaluateFilters } from "./match.mjs";

const env = process.env;
const die = (m) => { console.error(`::error::changed-paths: ${m}`); process.exit(1); };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Filters: YAML map name -> list of globs, parsed with yq (present on GitHub-hosted runners).
let filtersText = env.FILTERS ?? "";
if (existsSync(filtersText.trim()) && !filtersText.includes("\n")) filtersText = readFileSync(filtersText.trim(), "utf8");
let filters;
try { filters = JSON.parse(execFileSync("yq", ["-o=json", "."], { input: filtersText, encoding: "utf8" })); }
catch (e) { die(`could not parse filters as YAML (is yq installed?): ${e.message}`); }
if (!filters || typeof filters !== "object" || Array.isArray(filters)) die("filters must be a map of name -> list of globs");

// Base and head: explicit inputs win; otherwise derive from the event.
const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
let base = env.BASE || "", head = env.HEAD || "";
if (!head) head = event.pull_request?.head?.sha || env.GITHUB_SHA || "";
if (!base) {
  if (event.pull_request) base = event.pull_request.base.sha;
  else if (event.before && !/^0+$/.test(event.before)) base = event.before;
  else if (event.merge_group) base = event.merge_group.base_sha;
}
if (!base) die("could not determine the base commit; pass `base` explicitly");
if (!head) die("could not determine the head commit; pass `head` explicitly");

// Changed files via the compare API (no fetch-depth requirements). GitHub returns changed files
// only on the first page and caps the list at 300 for the entire comparison.
const maxCompareFiles = 300;
const files = [];
const body = JSON.parse(sh("gh", ["api", `repos/${env.GITHUB_REPOSITORY}/compare/${base}...${head}?per_page=1&page=1`]));
const compareFiles = body.files ?? [];
for (const f of compareFiles) { files.push(f.filename); if (f.previous_filename) files.push(f.previous_filename); }
const unique = [...new Set(files)];
console.log(`comparing ${base.slice(0, 12)}...${head.slice(0, 12)}: ${unique.length} changed path(s)`);

const failOpen = compareFiles.length >= maxCompareFiles;
if (failOpen) {
  console.warn(`::warning::changed-paths: GitHub's compare API returned its ${maxCompareFiles}-file maximum; treating every filter as changed because the file list may be incomplete`);
}

const results = evaluateFilters(filters, unique, failOpen);
const changes = [];
const out = [];
for (const [name, r] of Object.entries(results)) {
  const hit = r.hit;
  if (hit) changes.push(name);
  out.push(`${name}=${hit}`, `${name}_count=${r.matched.length}`);
  if ((env.LIST_FILES || "none") === "json") out.push(`${name}_files=${JSON.stringify(r.matched)}`);
  console.log(`${hit ? "changed  " : "unchanged"} ${name} (${r.matched.length})`);
}
out.push(`changes=${JSON.stringify(changes)}`);
appendFileSync(env.GITHUB_OUTPUT, out.join("\n") + "\n");
