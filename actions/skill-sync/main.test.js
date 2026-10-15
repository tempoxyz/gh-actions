const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { check, readTree, sync } = require("./main.js");
const { renderLock } = require("./skills.js");

const DOCS = "---\nname: tempo-docs\ndescription: Read Tempo docs.\n---\n# Docs\n";
const WALLET = "---\nname: tempo\ndescription: Use the Tempo wallet.\n---\n# Wallet\n";

// An in-memory stand-in for GitHubSource: repos map refs to commits, and
// commits map paths to files.
function fakeSource(repos) {
  const calls = [];
  return {
    calls,
    async resolve(repo, ref) {
      calls.push(["resolve", repo, ref]);
      const commit = repos[repo].refs[ref];
      if (!commit) throw new Error(`${repo}@${ref} not found`);
      return { commit, label: ref === "release" ? repos[repo].release : ref };
    },
    async files(repo, commit, file) {
      calls.push(["files", repo, commit, file]);
      const tree = repos[repo].commits[commit];
      if (tree[file] !== undefined) return new Map([["SKILL.md", Buffer.from(tree[file])]]);
      const files = new Map(Object.entries(tree).filter(([name]) => name.startsWith(`${file}/`)).map(([name, text]) => [name.slice(file.length + 1), Buffer.from(text)]));
      if (!files.size) throw new Error(`${repo}/${file} does not exist`);
      return files;
    },
    async text(repo, commit, file) {
      return repos[repo].commits[commit][file];
    },
  };
}

function sha(character) {
  return character.repeat(40);
}

function workspace(t, registry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (registry) fs.writeFileSync(path.join(root, "skills.json"), JSON.stringify({ skills: registry }));
  return root;
}

const options = { config: "skills.json", lock: "skills.lock.json", dest: "plugins/{plugin}/skills/{name}" };
const registry = [
  { name: "docs", repo: "tempoxyz/docs", path: "SKILL.md" },
  { name: "wallet", repo: "tempoxyz/wallet-cli", path: "SKILL.md", ref: "release" },
  { name: "mercator-setup", plugin: "mercator", repo: "tempoxyz/mercator", path: "skills/mercator-setup" },
];

function sources() {
  return {
    "tempoxyz/docs": { refs: { main: sha("a") }, commits: { [sha("a")]: { "SKILL.md": DOCS }, [sha("b")]: { "SKILL.md": DOCS.replace("# Docs", "# Docs v2") } } },
    "tempoxyz/wallet-cli": { release: "v1.0.0", refs: { release: sha("c") }, commits: { [sha("c")]: { "SKILL.md": WALLET } } },
    "tempoxyz/mercator": {
      refs: { main: sha("d") },
      commits: { [sha("d")]: { "skills/mercator-setup/SKILL.md": "---\nname: mercator-setup\ndescription: Set up.\n---\n", "skills/mercator-setup/references/a.md": "ref" } },
    },
  };
}

function read(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("first sync writes renamed copies, directories, the lock, and the index", async (t) => {
  const root = workspace(t, registry);
  const result = await sync({ ...options, root, index: "index.json", baseUrl: "https://tempo.xyz/skills", source: fakeSource(sources()) });

  assert.equal(result.changed, true);
  assert.match(read(root, "plugins/docs/skills/docs/SKILL.md"), /^---\nname: docs\n/);
  assert.match(read(root, "plugins/wallet/skills/wallet/SKILL.md"), /^---\nname: wallet\n/);
  assert.deepEqual([...readTree(path.join(root, "plugins/mercator/skills/mercator-setup")).keys()].sort(), ["SKILL.md", "references/a.md"]);

  const lock = JSON.parse(read(root, "skills.lock.json"));
  assert.deepEqual(lock.skills.map(({ name, commit, dest, ref }) => [name, commit, dest, ref]), [
    ["docs", sha("a"), "plugins/docs/skills/docs", "main"],
    ["mercator-setup", sha("d"), "plugins/mercator/skills/mercator-setup", "main"],
    ["wallet", sha("c"), "plugins/wallet/skills/wallet", "release"],
  ]);
  const index = JSON.parse(read(root, "index.json"));
  assert.deepEqual(index.skills.map(({ name, url }) => [name, url]), [
    ["docs", "https://tempo.xyz/skills/docs/SKILL.md"],
    ["mercator-setup", "https://tempo.xyz/skills/mercator-setup/SKILL.md"],
    ["wallet", "https://tempo.xyz/skills/wallet/SKILL.md"],
  ]);
  assert.match(result.summary, /added at `cccccccc` \(v1\.0\.0\)/);
  check({ ...options, root, index: "index.json", baseUrl: "https://tempo.xyz/skills" });
});

test("a source commit that does not change content leaves the lock untouched", async (t) => {
  const root = workspace(t, registry);
  const repos = sources();
  await sync({ ...options, root, source: fakeSource(repos) });
  const before = read(root, "skills.lock.json");

  repos["tempoxyz/docs"].refs.main = sha("e");
  repos["tempoxyz/docs"].commits[sha("e")] = repos["tempoxyz/docs"].commits[sha("a")];
  const result = await sync({ ...options, root, source: fakeSource(repos) });

  assert.equal(result.changed, false);
  assert.equal(read(root, "skills.lock.json"), before);
});

test("changed content is rewritten and summarized with a compare link", async (t) => {
  const root = workspace(t, registry);
  const repos = sources();
  await sync({ ...options, root, source: fakeSource(repos) });

  repos["tempoxyz/docs"].refs.main = sha("b");
  const result = await sync({ ...options, root, source: fakeSource(repos) });

  assert.equal(result.changed, true);
  assert.match(read(root, "plugins/docs/skills/docs/SKILL.md"), /# Docs v2/);
  assert.match(result.summary, /compare\/a{40}\.\.\.b{40}/);
  assert.doesNotMatch(result.summary, /wallet/);
});

test("a hand edit fails check and the next sync restores the source", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, source: fakeSource(sources()) });
  fs.appendFileSync(path.join(root, "plugins/docs/skills/docs/SKILL.md"), "hand edit\n");

  assert.throws(() => check({ ...options, root }), /plugins\/docs\/skills\/docs does not match tempoxyz\/docs\/SKILL.md@aaaaaaaa\. It is generated: edit tempoxyz\/docs\/SKILL.md/);
  const result = await sync({ ...options, root, source: fakeSource(sources()) });
  assert.equal(result.changed, true);
  check({ ...options, root });
});

test("a stale index fails check", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, index: "index.json", baseUrl: "/skills", source: fakeSource(sources()) });
  fs.writeFileSync(path.join(root, "index.json"), "{}\n");
  assert.throws(() => check({ ...options, root, index: "index.json", baseUrl: "/skills" }), /index\.json is out of date/);
});

test("removing a registry entry deletes its copy and lock entry", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, source: fakeSource(sources()) });
  fs.writeFileSync(path.join(root, "skills.json"), JSON.stringify({ skills: registry.slice(0, 2) }));

  const result = await sync({ ...options, root, source: fakeSource(sources()) });

  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(root, "plugins/mercator/skills/mercator-setup")), false);
  assert.deepEqual(JSON.parse(read(root, "skills.lock.json")).skills.map(({ name }) => name), ["docs", "wallet"]);
  assert.match(result.summary, /`mercator-setup` .* removed/);
});

test("only syncs the selected skills and keeps other lock entries", async (t) => {
  const root = workspace(t, registry);
  const repos = sources();
  await sync({ ...options, root, source: fakeSource(repos) });
  repos["tempoxyz/docs"].refs.main = sha("b");
  fs.writeFileSync(path.join(root, "skills.json"), JSON.stringify({ skills: registry.slice(0, 2) }));
  const source = fakeSource(repos);

  const result = await sync({ ...options, root, only: ["wallet"], source });

  assert.equal(result.changed, false);
  assert.deepEqual(source.calls.filter(([kind]) => kind === "resolve").map(([, repo]) => repo), ["tempoxyz/wallet-cli"]);
  assert.equal(fs.existsSync(path.join(root, "plugins/mercator/skills/mercator-setup")), true);
  await assert.rejects(sync({ ...options, root, only: ["missing"], source }), /no skills match: missing/);
});

test("only can remove a plugin's last skill", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, source: fakeSource(sources()) });
  fs.writeFileSync(path.join(root, "skills.json"), JSON.stringify({ skills: registry.slice(0, 2) }));

  const result = await sync({ ...options, root, only: ["mercator"], source: fakeSource(sources()) });

  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(root, "plugins/mercator/skills/mercator-setup")), false);
  assert.deepEqual(JSON.parse(read(root, "skills.lock.json")).skills.map(({ name }) => name), ["docs", "wallet"]);
});

test("writes a lock file in a new directory", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, lock: ".generated/skills.lock.json", source: fakeSource(sources()) });
  check({ ...options, root, lock: ".generated/skills.lock.json" });
});

test("moving a destination removes the old copy", async (t) => {
  const root = workspace(t, registry);
  await sync({ ...options, root, source: fakeSource(sources()) });
  const result = await sync({ ...options, root, dest: "public/skills/{name}", source: fakeSource(sources()) });

  assert.equal(result.changed, true);
  assert.equal(fs.existsSync(path.join(root, "plugins")), true);
  assert.equal(fs.existsSync(path.join(root, "plugins/docs/skills/docs")), false);
  assert.match(read(root, "public/skills/docs/SKILL.md"), /name: docs/);
});

test("catalog mode mirrors another repository's lock with upstream provenance", async (t) => {
  const catalogRoot = workspace(t, registry);
  await sync({ ...options, root: catalogRoot, source: fakeSource(sources()) });
  const tree = {};
  for (const file of ["skills.lock.json", ...[...readTree(path.join(catalogRoot, "plugins")).keys()].map((file) => `plugins/${file}`)]) {
    tree[file] = read(catalogRoot, file);
  }
  const repos = { "tempoxyz/plugins": { refs: { main: sha("f") }, commits: { [sha("f")]: tree } } };
  const root = workspace(t);
  const mirror = { ...options, root, catalog: "tempoxyz/plugins", dest: "public/skills/{name}", index: "public/.well-known/agent-skills/index.json", baseUrl: "https://tempo.xyz/skills" };

  const result = await sync({ ...mirror, source: fakeSource(repos) });

  assert.equal(result.changed, true);
  assert.equal(read(root, "public/skills/wallet/SKILL.md"), read(catalogRoot, "plugins/wallet/skills/wallet/SKILL.md"));
  assert.equal(read(root, "public/skills/mercator-setup/references/a.md"), "ref");
  const docs = JSON.parse(read(root, "skills.lock.json")).skills.find(({ name }) => name === "docs");
  assert.deepEqual(docs.upstream, { repo: "tempoxyz/docs", path: "SKILL.md", commit: sha("a") });
  assert.equal(docs.repo, "tempoxyz/plugins");

  fs.appendFileSync(path.join(root, "public/skills/docs/SKILL.md"), "edit\n");
  assert.throws(() => check(mirror), /edit tempoxyz\/docs\/SKILL.md and let the sync update it/);
  await sync({ ...mirror, source: fakeSource(repos) });

  // A skill that moves to another source keeps its bytes but not its provenance.
  const lock = JSON.parse(tree["skills.lock.json"]);
  lock.skills.find(({ name }) => name === "docs").upstream = undefined;
  Object.assign(lock.skills.find(({ name }) => name === "docs"), { repo: "tempoxyz/docs-next", path: "skill/SKILL.md", commit: sha("9") });
  repos["tempoxyz/plugins"].commits[sha("f")]["skills.lock.json"] = JSON.stringify(lock);
  const moved = await sync({ ...mirror, source: fakeSource(repos) });
  assert.equal(moved.changed, true);
  assert.deepEqual(JSON.parse(read(root, "skills.lock.json")).skills.find(({ name }) => name === "docs").upstream, { repo: "tempoxyz/docs-next", path: "skill/SKILL.md", commit: sha("9") });

  // A new upstream commit with the same bytes and source is not a change.
  Object.assign(lock.skills.find(({ name }) => name === "docs"), { commit: sha("8") });
  repos["tempoxyz/plugins"].commits[sha("f")]["skills.lock.json"] = JSON.stringify(lock);
  assert.equal((await sync({ ...mirror, source: fakeSource(repos) })).changed, false);
});

test("check accepts an empty repository and notes unsynced entries", (t) => {
  const root = workspace(t, registry);
  fs.writeFileSync(path.join(root, "skills.lock.json"), renderLock([]));
  check({ ...options, root });
});

test("readTree rejects symlinks in generated copies", (t) => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, "skill"));
  fs.writeFileSync(path.join(root, "skill/SKILL.md"), "x");
  fs.symlinkSync("SKILL.md", path.join(root, "skill/link.md"));
  assert.throws(() => readTree(path.join(root, "skill")), /only regular files are allowed/);
});
