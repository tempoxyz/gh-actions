const assert = require("node:assert/strict");
const test = require("node:test");
const { GitHubSource, encodePath, stsMinter } = require("./github.js");

const API = "https://api.github.test";
const COMMIT = "a".repeat(40);

function blob(text) {
  return { status: 200, body: JSON.stringify({ content: Buffer.from(text).toString("base64"), encoding: "base64" }), headers: {} };
}

// Routes request URLs to canned responses and records the token each used.
function fakeSend(routes) {
  const calls = [];
  const send = async (url, options) => {
    const route = url.replace(API, "");
    calls.push([route, options.headers.Authorization, options.headers.Accept]);
    const response = routes[route];
    if (!response) return { status: 404, body: "{}", headers: {} };
    return typeof response === "function" ? response(options) : response;
  };
  return { calls, send };
}

function json(value) {
  return { status: 200, body: JSON.stringify(value), headers: {} };
}

test("encodes each path segment", () => {
  assert.equal(encodePath("feature/a b"), "feature/a%20b");
});

for (const [ref, routes, expected] of [
  ["main", { "/repos/o/r/commits/main": { status: 200, body: `${COMMIT}\n`, headers: {} } }, { commit: COMMIT, label: "main" }],
  ["release", {
    "/repos/o/r/releases/latest": json({ tag_name: "v1.2.3" }),
    "/repos/o/r/commits/v1.2.3": { status: 200, body: COMMIT, headers: {} },
  }, { commit: COMMIT, label: "v1.2.3" }],
]) {
  test(`resolves ${ref} to a commit`, async () => {
    const { calls, send } = fakeSend(routes);
    assert.deepEqual(await new GitHubSource({ token: "t", send, apiUrl: API }).resolve("o/r", ref), expected);
    assert.equal(calls.at(-1)[2], "application/vnd.github.sha");
  });
}

test("rejects a ref that does not resolve to a commit", async () => {
  const { send } = fakeSend({ "/repos/o/r/commits/main": { status: 200, body: "nope", headers: {} } });
  await assert.rejects(new GitHubSource({ send, apiUrl: API }).resolve("o/r", "main"), /did not resolve to a commit/);
});

function tree(entries, truncated = false) {
  return json({ truncated, tree: entries });
}

const blobEntry = (path, sha, mode = "100644") => ({ path, type: "blob", mode, sha });
const treeEntry = (path, sha) => ({ path, type: "tree", mode: "040000", sha });

test("copies a nested file source as SKILL.md by walking trees", async () => {
  const { calls, send } = fakeSend({
    [`/repos/o/r/git/trees/${COMMIT}`]: tree([treeEntry("apps", "t-apps")]),
    "/repos/o/r/git/trees/t-apps": tree([treeEntry("cli", "t-cli")]),
    "/repos/o/r/git/trees/t-cli": tree([blobEntry("SKILL.md", "s1")]),
    "/repos/o/r/git/blobs/s1": blob("skill"),
  });
  const files = await new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "apps/cli/SKILL.md");
  assert.deepEqual([...files].map(([name, content]) => [name, content.toString()]), [["SKILL.md", "skill"]]);
  assert.ok(!calls.some(([route]) => route.includes("/contents/")));
});

test("copies a directory source whole", async () => {
  const { send } = fakeSend({
    [`/repos/o/r/git/trees/${COMMIT}`]: tree([treeEntry("skill", "t1")]),
    "/repos/o/r/git/trees/t1?recursive=1": tree([
      blobEntry("SKILL.md", "s1"),
      treeEntry("references", "t2"),
      blobEntry("references/a.md", "s2"),
    ]),
    "/repos/o/r/git/blobs/s1": blob("skill"),
    "/repos/o/r/git/blobs/s2": blob("ref"),
  });
  const files = await new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "skill");
  assert.deepEqual([...files.keys()], ["SKILL.md", "references/a.md"]);
});

test("finds a source in a directory with more than 1,000 entries", async () => {
  const siblings = Array.from({ length: 1500 }, (_, index) => blobEntry(`file-${index}.md`, `x${index}`));
  const { send } = fakeSend({
    [`/repos/o/r/git/trees/${COMMIT}`]: tree([...siblings, blobEntry("SKILL.md", "s1")]),
    "/repos/o/r/git/blobs/s1": blob("skill"),
  });
  const files = await new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "SKILL.md");
  assert.equal(files.get("SKILL.md").toString(), "skill");
});

for (const [label, root, subtree, message] of [
  ["a missing path", [], null, /skill does not exist/],
  ["a path below a file", [blobEntry("skill", "s1")], null, /skill\/SKILL\.md does not exist/],
  ["a truncated level", { truncated: true, entries: [] }, null, /tree listing for skill is truncated/],
  ["a symlink path", [blobEntry("skill", "x", "120000")], null, /symlinks and submodules are not copied/],
  ["a submodule path", [{ path: "skill", type: "commit", mode: "160000", sha: "x" }], null, /submodules are not copied/],
  ["a truncated tree", [treeEntry("skill", "t1")], { truncated: true, entries: [] }, /tree listing is truncated/],
  ["a symlink inside", [treeEntry("skill", "t1")], [blobEntry("a", "x", "120000")], /symlinks and submodules/],
  ["a submodule inside", [treeEntry("skill", "t1")], [{ path: "a", type: "commit", mode: "160000", sha: "x" }], /symlinks and submodules/],
  ["an executable inside", [treeEntry("skill", "t1")], [blobEntry("SKILL.md", "s1"), blobEntry("run.sh", "s2", "100755")], /skill\/run\.sh: executable files are not copied/],
  ["no SKILL.md", [treeEntry("skill", "t1")], [], /has no SKILL\.md/],
]) {
  test(`rejects ${label}`, async () => {
    const listing = (value) => (Array.isArray(value) ? tree(value) : tree(value.entries, value.truncated));
    const routes = { [`/repos/o/r/git/trees/${COMMIT}`]: listing(root), "/repos/o/r/git/blobs/s1": blob("skill") };
    if (subtree) routes["/repos/o/r/git/trees/t1?recursive=1"] = listing(subtree);
    const { send } = fakeSend(routes);
    const target = label === "a path below a file" ? "skill/SKILL.md" : "skill";
    await assert.rejects(new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, target), message);
  });
}

test("reads a text file such as a catalog lock", async () => {
  const { send } = fakeSend({
    [`/repos/o/r/git/trees/${COMMIT}`]: tree([blobEntry("skills.lock.json", "s1")]),
    "/repos/o/r/git/blobs/s1": blob("{}"),
  });
  assert.equal(await new GitHubSource({ send, apiUrl: API }).text("o/r", COMMIT, "skills.lock.json"), "{}");
});

test("retries a hidden repository once with a minted read token", async () => {
  const { calls, send } = fakeSend({
    "/repos/o/private/commits/main": (options) => (options.headers.Authorization === "Bearer minted"
      ? { status: 200, body: COMMIT, headers: {} }
      : { status: 404, body: "{}", headers: {} }),
  });
  const minted = [];
  const minter = { policy: "skill-sync-read", mint: async (repo) => { minted.push(repo); return "minted"; } };
  const source = new GitHubSource({ token: "default", minter, send, apiUrl: API });

  assert.deepEqual(await source.resolve("o/private", "main"), { commit: COMMIT, label: "main" });
  await source.resolve("o/private", "main");
  assert.deepEqual(minted, ["o/private"]);
  assert.deepEqual(calls.map(([, token]) => token), ["Bearer default", "Bearer minted", "Bearer minted"]);
});

test("explains how to grant access when a repository is hidden", async () => {
  const { send } = fakeSend({});
  await assert.rejects(
    new GitHubSource({ token: "default", send, apiUrl: API }).resolve("o/private", "main"),
    /HTTP 404\)\. If o\/private is private, add \.github\/sts\/skill-sync-read\.sts\.yaml to it and grant this job id-token: write\./,
  );
});

test("minting needs a GitHub Actions OIDC environment", () => {
  assert.equal(stsMinter({ policy: "p", host: "sts.test", env: {} }), null);
  assert.equal(typeof stsMinter({ policy: "p", host: "sts.test", env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x", ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test" } }).mint, "function");
});
