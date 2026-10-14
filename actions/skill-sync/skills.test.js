const assert = require("node:assert/strict");
const test = require("node:test");
const {
  description,
  parseRegistry,
  renderDest,
  renderIndex,
  renderLock,
  renderSummary,
  rewriteName,
  sha256,
  treeDigest,
} = require("./skills.js");

const entry = { name: "docs", repo: "tempoxyz/docs", path: "SKILL.md" };

test("parses registry entries with defaults", () => {
  assert.deepEqual(parseRegistry(JSON.stringify({ skills: [entry, { ...entry, name: "wallet", plugin: "tools", ref: "release" }] })), [
    { name: "docs", plugin: "docs", repo: "tempoxyz/docs", path: "SKILL.md", ref: "main" },
    { name: "wallet", plugin: "tools", repo: "tempoxyz/docs", path: "SKILL.md", ref: "release" },
  ]);
});

for (const [label, skills, message] of [
  ["missing skills array", {}, /expected a "skills" array/],
  ["non-object entry", ["docs"], /expected an object/],
  ["unknown key", [{ ...entry, source: "x" }], /unknown key "source"/],
  ["invalid name", [{ ...entry, name: "Docs" }], /"name" must be lowercase/],
  ["invalid plugin", [{ ...entry, plugin: "a_b" }], /"plugin" must be lowercase/],
  ["invalid repo", [{ ...entry, repo: "docs" }], /"repo" must be owner\/name/],
  ["absolute path", [{ ...entry, path: "/SKILL.md" }], /"path" must be a relative path/],
  ["parent path", [{ ...entry, path: "../SKILL.md" }], /"path" must be a relative path/],
  ["trailing slash", [{ ...entry, path: "skills/docs/" }], /"path" must be a relative path/],
  ["empty ref", [{ ...entry, ref: "" }], /"ref" must be/],
  ["duplicate name", [entry, entry], /duplicate skill "docs"/],
]) {
  test(`rejects registry with ${label}`, () => {
    const text = JSON.stringify(Array.isArray(skills) ? { skills } : skills);
    assert.throws(() => parseRegistry(text), message);
  });
}

for (const [template, expected] of [
  ["plugins/{plugin}/skills/{name}", "plugins/tempo/skills/docs"],
  ["public/skills/{name}", "public/skills/docs"],
]) {
  test(`renders dest ${template}`, () => {
    assert.equal(renderDest(template, { name: "docs", plugin: "tempo" }), expected);
  });
}

for (const [template, message] of [
  ["skills/{repo}", /unknown placeholder \{repo\}/],
  ["/skills/{name}", /must be a relative path/],
  ["../{name}", /must be a relative path/],
]) {
  test(`rejects dest ${template}`, () => {
    assert.throws(() => renderDest(template, { name: "docs", plugin: "docs" }), message);
  });
}

for (const [label, input, expected] of [
  ["renames", "---\nname: tempo-docs\ndescription: d\n---\n# Docs\n", "---\nname: docs\ndescription: d\n---\n# Docs\n"],
  ["keeps a matching name", "---\nname: docs\n---\nbody\n", "---\nname: docs\n---\nbody\n"],
  ["keeps CRLF line endings", "---\r\nname: tempo\r\n---\r\nbody\r\n", "---\r\nname: docs\r\n---\r\nbody\r\n"],
  ["only touches frontmatter", "---\nname: tempo\n---\nname: tempo\n", "---\nname: docs\n---\nname: tempo\n"],
]) {
  test(`rewriteName ${label}`, () => {
    assert.equal(rewriteName(input, "docs"), expected);
  });
}

for (const [label, input, message] of [
  ["without frontmatter", "# Docs\n", /must start with YAML frontmatter/],
  ["without a name", "---\ndescription: d\n---\n", /has no name/],
]) {
  test(`rewriteName rejects a skill ${label}`, () => {
    assert.throws(() => rewriteName(input, "docs"), message);
  });
}

for (const [label, frontmatter, expected] of [
  ["plain", "description: Read Tempo docs.", "Read Tempo docs."],
  ["double-quoted", 'description: "Read \\"Tempo\\" docs."', 'Read "Tempo" docs.'],
  ["single-quoted", "description: 'Read Tempo''s docs.'", "Read Tempo's docs."],
  ["multi-line plain", "description: Read Tempo\n  docs.", "Read Tempo docs."],
  ["folded", "description: >\n  Read Tempo\n  docs.\n\n  Then build.", "Read Tempo docs.\nThen build."],
  ["literal", "description: |\n  Line one\n  Line two", "Line one\nLine two"],
  ["followed by keys", "description: >-\n  Read docs.\nlicense: MIT", "Read docs."],
]) {
  test(`reads a ${label} description`, () => {
    assert.equal(description(`---\nname: docs\n${frontmatter}\n---\nbody\n`), expected);
  });
}

test("rejects a missing description", () => {
  assert.throws(() => description("---\nname: docs\n---\n"), /has no description/);
});

test("tree digests ignore file order but not paths or content", () => {
  const files = [["SKILL.md", Buffer.from("a")], ["references/b.md", Buffer.from("b")]];
  const digest = treeDigest(new Map(files));
  assert.equal(digest, treeDigest(new Map([...files].reverse())));
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(digest, treeDigest(new Map([["SKILL.md", Buffer.from("a")], ["references/c.md", Buffer.from("b")]])));
  assert.notEqual(digest, treeDigest(new Map([["SKILL.md", Buffer.from("a")], ["references/b.md", Buffer.from("c")]])));
});

test("renders a sorted discovery index", () => {
  const skill = (name) => ({ name, text: `---\nname: ${name}\ndescription: ${name} skill\n---\n`, url: `/skills/${name}/SKILL.md` });
  const index = JSON.parse(renderIndex([skill("wallet"), skill("docs")]));
  assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  assert.deepEqual(index.skills.map(({ name }) => name), ["docs", "wallet"]);
  assert.deepEqual(index.skills[0], {
    description: "docs skill",
    digest: `sha256:${sha256(skill("docs").text)}`,
    name: "docs",
    type: "skill-md",
    url: "/skills/docs/SKILL.md",
  });
});

test("renders a sorted, versioned lock", () => {
  assert.equal(renderLock([{ name: "wallet" }, { name: "docs" }]), `${JSON.stringify({ version: 1, skills: [{ name: "docs" }, { name: "wallet" }] }, null, 2)}\n`);
});

test("summarizes changes with source and compare links", () => {
  const commit = "b".repeat(40);
  const summary = renderSummary([
    { name: "wallet", repo: "tempoxyz/wallet-cli", path: "SKILL.md", ref: "release", label: "v1.2.3", commit },
    { name: "docs", repo: "tempoxyz/docs", path: "SKILL.md", ref: "main", label: "main", commit, from: "a".repeat(40) },
    { name: "old", repo: "tempoxyz/old", path: "skills/old", commit, removed: true },
  ]);
  const lines = summary.split("\n");
  assert.equal(lines[0], "| Skill | Source | Change |");
  assert.match(lines[2], /^\| `docs` \| \[tempoxyz\/docs\/SKILL.md\]\(https:\/\/github.com\/tempoxyz\/docs\/blob\/b+\/SKILL.md\) \| \[`aaaaaaaa`\]\(https:\/\/github.com\/tempoxyz\/docs\/compare\/a+\.\.\.b+\) → `bbbbbbbb` \|$/);
  assert.match(lines[3], /^\| `old` \| \[tempoxyz\/old\/skills\/old\]\(https:\/\/github.com\/tempoxyz\/old\/tree\/b+\/skills\/old\) \| removed \|$/);
  assert.match(lines[4], /added at `bbbbbbbb` \(v1\.2\.3\) \|$/);
  assert.equal(renderSummary([]), "All skills match their sources.");
});
