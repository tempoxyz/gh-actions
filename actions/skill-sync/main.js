const fs = require("node:fs");
const path = require("node:path");
const { GitHubSource, stsMinter } = require("./github.js");
const {
  isRelativePath,
  parseLock,
  parseRegistry,
  renderDest,
  renderIndex,
  renderLock,
  renderSummary,
  rewriteName,
  treeDigest,
} = require("./skills.js");

function input(name, fallback = "") {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replaceAll("-", "_")}`] || fallback;
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `skill_sync_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function readTree(directory) {
  const files = new Map();
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.set(child, fs.readFileSync(path.join(directory, child)));
      else throw new Error(`${path.join(directory, child)}: only regular files are allowed in a generated skill`);
    }
  };
  walk("");
  return files;
}

function digestOnDisk(root, dest) {
  const directory = path.join(root, dest);
  return fs.existsSync(directory) ? treeDigest(readTree(directory)) : null;
}

function removeTree(root, dest) {
  if (!isRelativePath(dest)) throw new Error(`refusing to remove "${dest}"`);
  fs.rmSync(path.join(root, dest), { recursive: true, force: true });
}

function writeTree(root, dest, files) {
  removeTree(root, dest);
  for (const [file, content] of files) {
    if (!isRelativePath(file)) throw new Error(`refusing to write "${file}"`);
    const target = path.join(root, dest, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function readLock(file) {
  return fs.existsSync(file) ? parseLock(fs.readFileSync(file, "utf8"), file) : new Map();
}

function upstreamOf(entry) {
  return entry.upstream ?? { repo: entry.repo, path: entry.path, commit: entry.commit };
}

// In catalog mode the source is another repository's lock file, so a website
// mirrors whatever a distribution repository has already validated.
async function catalogEntries(source, catalog, ref = "main") {
  const { commit } = await source.resolve(catalog, ref);
  const lock = parseLock(await source.text(catalog, commit, "skills.lock.json"), `${catalog}/skills.lock.json`);
  return [...lock.values()].map((entry) => ({
    name: entry.name,
    plugin: entry.plugin,
    repo: catalog,
    path: entry.dest,
    ref,
    commit,
    upstream: upstreamOf(entry),
  }));
}

function renderIndexFile(root, entries, baseUrl) {
  return renderIndex([...entries.values()].map((entry) => ({
    name: entry.name,
    text: fs.readFileSync(path.join(root, entry.dest, "SKILL.md"), "utf8"),
    url: `${baseUrl.replace(/\/$/, "")}/${entry.name}/SKILL.md`,
  })));
}

function syncIndex(root, index, baseUrl, entries, check) {
  if (!index) return false;
  if (!baseUrl) throw new Error("base-url is required with index");
  const file = path.join(root, index);
  const rendered = renderIndexFile(root, entries, baseUrl);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === rendered) return false;
  if (!check) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rendered);
  }
  return true;
}

// A catalog entry that moved to another source is refreshed even when its
// bytes did not change; a new upstream commit alone is not a change.
function sameUpstream(old, entry) {
  return old.upstream?.repo === entry.upstream?.repo && old.upstream?.path === entry.upstream?.path;
}

function selects(only, entry) {
  return only.length === 0 || only.includes(entry.name) || only.includes(entry.plugin);
}

// Brings every selected skill's generated copy in line with its source.
// Content that is unchanged keeps its lock entry, so source commits that do
// not touch a skill never produce a diff.
async function sync({ root, config, lock, dest, catalog, index, baseUrl, only = [], source }) {
  const lockFile = path.join(root, lock);
  const previous = readLock(lockFile);
  const entries = catalog
    ? await catalogEntries(source, catalog)
    : parseRegistry(fs.readFileSync(path.join(root, config), "utf8"), config);
  const selected = entries.filter((entry) => selects(only, entry));
  if (only.length && !selected.length && ![...previous.values()].some((entry) => selects(only, entry))) {
    throw new Error(`no skills match: ${only.join(", ")}`);
  }

  const next = new Map(previous);
  const changes = [];
  const resolved = new Map();
  for (const entry of selected) {
    const target = renderDest(dest, entry);
    const key = `${entry.repo}@${entry.ref}`;
    if (!resolved.has(key)) resolved.set(key, entry.commit ? { commit: entry.commit, label: entry.ref } : await source.resolve(entry.repo, entry.ref));
    const { commit, label } = resolved.get(key);

    const files = await source.files(entry.repo, commit, entry.path);
    if (!catalog) files.set("SKILL.md", Buffer.from(rewriteName(files.get("SKILL.md").toString("utf8"), entry.name)));
    const digest = treeDigest(files);

    const old = previous.get(entry.name);
    const unchanged = old && old.digest === digest && old.dest === target && old.repo === entry.repo
      && old.path === entry.path && old.ref === entry.ref && sameUpstream(old, entry)
      && digestOnDisk(root, target) === digest;
    if (unchanged) continue;

    if (old && old.dest !== target) removeTree(root, old.dest);
    writeTree(root, target, files);
    next.set(entry.name, {
      name: entry.name,
      plugin: entry.plugin,
      repo: entry.repo,
      path: entry.path,
      ref: entry.ref,
      commit,
      digest,
      dest: target,
      ...(entry.upstream ? { upstream: entry.upstream } : {}),
    });
    changes.push({ ...entry, commit, label, from: old?.commit });
  }

  const wanted = new Set(entries.map((entry) => entry.name));
  for (const [name, old] of previous) {
    if (wanted.has(name) || !selects(only, old)) continue;
    removeTree(root, old.dest);
    next.delete(name);
    changes.push({ ...old, removed: true });
  }

  if (changes.length) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, renderLock(next.values()));
  }
  const indexChanged = syncIndex(root, index, baseUrl, next, false);
  return { changed: changes.length > 0 || indexChanged, summary: renderSummary(changes) };
}

// Offline verification for CI: every generated copy must still match the
// digest it was synced with, so hand edits fail with a pointer upstream.
function check({ root, config, lock, catalog, index, baseUrl }) {
  const entries = readLock(path.join(root, lock));
  const problems = [];
  for (const entry of entries.values()) {
    if (digestOnDisk(root, entry.dest) === entry.digest) continue;
    const upstream = upstreamOf(entry);
    problems.push(`${entry.dest} does not match ${upstream.repo}/${upstream.path}@${upstream.commit.slice(0, 8)}. It is generated: edit ${upstream.repo}/${upstream.path} and let the sync update it.`);
  }
  if (!catalog && config && fs.existsSync(path.join(root, config))) {
    for (const entry of parseRegistry(fs.readFileSync(path.join(root, config), "utf8"), config)) {
      if (!entries.has(entry.name)) console.log(`::notice::${entry.name} is registered but not synced yet; the next sync adds it.`);
    }
  }
  if (problems.length === 0 && syncIndex(root, index, baseUrl, entries, true)) {
    problems.push(`${index} is out of date with ${lock}.`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
}

async function main() {
  const options = {
    root: path.resolve(input("working-directory", ".")),
    config: input("config", "skills.json"),
    lock: input("lock", "skills.lock.json"),
    dest: input("dest", "plugins/{plugin}/skills/{name}"),
    catalog: input("catalog"),
    index: input("index"),
    baseUrl: input("base-url"),
    only: input("only").split(/[\s,]+/).filter(Boolean),
  };
  const mode = input("mode", "sync");
  if (mode === "check") {
    check(options);
    console.log("Generated skills match their lock.");
    return;
  }
  if (mode !== "sync") throw new Error(`mode must be sync or check, got "${mode}"`);

  const minter = stsMinter({ policy: input("sts-policy", "skill-sync-read"), host: input("sts-host", "gh-sts.tempoxyz.net") });
  const source = new GitHubSource({ token: input("token") || process.env.GH_TOKEN || process.env.GITHUB_TOKEN, minter });
  try {
    const { changed, summary } = await sync({ ...options, source });
    console.log(summary);
    output("changed", String(changed));
    output("summary", summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  } finally {
    await minter?.revokeAll();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error.message.replaceAll("\n", "%0A")}`);
    process.exitCode = 1;
  });
}

module.exports = { catalogEntries, check, main, readTree, sync };
