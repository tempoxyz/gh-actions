const { createHash } = require("node:crypto");

const INDEX_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REGISTRY_KEYS = new Set(["name", "plugin", "repo", "path", "ref"]);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function isRelativePath(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

// A registry entry names one skill, the plugin that ships it, and where its
// canonical source lives. `ref` is a branch, tag, or `release` (the repository's
// latest GitHub release).
function parseRegistry(text, file = "skills.json") {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.skills)) throw new Error(`${file}: expected a "skills" array`);
  const names = new Set();
  return data.skills.map((entry, index) => {
    const where = `${file}: skills[${index}]`;
    if (entry === null || typeof entry !== "object") throw new Error(`${where}: expected an object`);
    for (const key of Object.keys(entry)) {
      if (!REGISTRY_KEYS.has(key)) throw new Error(`${where}: unknown key "${key}"`);
    }
    const { name, plugin = name, repo, path, ref = "main" } = entry;
    if (typeof name !== "string" || !NAME.test(name)) throw new Error(`${where}: "name" must be lowercase kebab-case`);
    if (typeof plugin !== "string" || !NAME.test(plugin)) throw new Error(`${where}: "plugin" must be lowercase kebab-case`);
    if (typeof repo !== "string" || !REPO.test(repo)) throw new Error(`${where}: "repo" must be owner/name`);
    if (!isRelativePath(path)) throw new Error(`${where}: "path" must be a relative path inside the repository`);
    if (typeof ref !== "string" || ref === "" || /\s/.test(ref)) throw new Error(`${where}: "ref" must be a branch, tag, or "release"`);
    if (names.has(name)) throw new Error(`${where}: duplicate skill "${name}"`);
    names.add(name);
    return { name, plugin, repo, path, ref };
  });
}

function renderDest(template, entry) {
  const dest = template.replace(/\{([^}]*)\}/g, (_, key) => {
    if (key !== "name" && key !== "plugin") throw new Error(`dest: unknown placeholder {${key}}`);
    return entry[key];
  });
  if (!isRelativePath(dest)) throw new Error(`dest: "${dest}" must be a relative path`);
  return dest;
}

function frontmatterOf(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter");
  return match;
}

// Plugins require a skill's frontmatter name to match its directory, so the
// distributed copy may differ from its source in this one line.
function rewriteName(text, name) {
  const match = frontmatterOf(text);
  if (!/^name:/m.test(match[1])) throw new Error("SKILL.md frontmatter has no name");
  const frontmatter = match[0].replace(/^name:[^\r\n]*/m, `name: ${name}`);
  return frontmatter + text.slice(match[0].length);
}

function unquote(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

// Reads the frontmatter description as YAML would for the scalar styles skill
// files use: plain, quoted, folded (>), and literal (|).
function description(text) {
  const lines = frontmatterOf(text)[1].split(/\r?\n/);
  const start = lines.findIndex((line) => /^description:/.test(line));
  if (start < 0) throw new Error("SKILL.md frontmatter has no description");
  const head = lines[start].slice("description:".length).trim();
  const continuation = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    continuation.push(line.trim());
  }
  while (continuation.at(-1) === "") continuation.pop();
  if (/^[>|][+-]?$/.test(head)) {
    if (head.startsWith("|")) return continuation.join("\n");
    return continuation.join("\n").split(/\n{2,}/).map((paragraph) => paragraph.replaceAll("\n", " ")).join("\n");
  }
  const value = unquote([head, ...continuation].filter(Boolean).join(" "));
  if (!value) throw new Error("SKILL.md frontmatter description is empty");
  return value;
}

// Order-independent digest of a skill directory: each file's path and
// content hash, sorted by path.
function treeDigest(files) {
  const hash = createHash("sha256");
  for (const [path, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${path}\0${sha256(content)}\n`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function parseLock(text, file = "skills.lock.json") {
  const data = JSON.parse(text);
  if (!Array.isArray(data?.skills)) throw new Error(`${file}: expected a "skills" array`);
  return new Map(data.skills.map((entry) => [entry.name, entry]));
}

function renderLock(entries) {
  return `${JSON.stringify({ version: 1, skills: [...entries].sort(byName) }, null, 2)}\n`;
}

function renderIndex(skills) {
  const entries = [...skills].sort(byName).map((skill) => ({
    description: description(skill.text),
    digest: `sha256:${sha256(skill.text)}`,
    name: skill.name,
    type: "skill-md",
    url: skill.url,
  }));
  return `${JSON.stringify({ $schema: INDEX_SCHEMA, skills: entries }, null, 2)}\n`;
}

function sourceUrl({ repo, path, commit }, directory) {
  return `https://github.com/${repo}/${directory ? "tree" : "blob"}/${commit}/${path}`;
}

function renderSummary(changes) {
  if (!changes.length) return "All skills match their sources.";
  const rows = [...changes].sort(byName).map((change) => {
    const source = `[${change.repo}/${change.path}](${sourceUrl(change, !change.path.endsWith(".md"))})`;
    if (change.removed) return `| \`${change.name}\` | ${source} | removed |`;
    const to = `\`${change.commit.slice(0, 8)}\`${change.label && change.label !== change.ref ? ` (${change.label})` : ""}`;
    const from = change.from ? `[\`${change.from.slice(0, 8)}\`](https://github.com/${change.repo}/compare/${change.from}...${change.commit}) → ` : "added at ";
    return `| \`${change.name}\` | ${source} | ${from}${to} |`;
  });
  return ["| Skill | Source | Change |", "| --- | --- | --- |", ...rows].join("\n");
}

module.exports = {
  INDEX_SCHEMA,
  description,
  isRelativePath,
  parseLock,
  parseRegistry,
  renderDest,
  renderIndex,
  renderLock,
  renderSummary,
  rewriteName,
  sha256,
  treeDigest,
};
