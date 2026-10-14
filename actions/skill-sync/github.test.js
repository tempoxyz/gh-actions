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

test("copies a file source as SKILL.md", async () => {
  const { send } = fakeSend({
    [`/repos/o/r/contents/apps/cli?ref=${COMMIT}`]: json([{ path: "apps/cli/SKILL.md", type: "file", sha: "s1" }]),
    "/repos/o/r/git/blobs/s1": blob("skill"),
  });
  const files = await new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "apps/cli/SKILL.md");
  assert.deepEqual([...files].map(([name, content]) => [name, content.toString()]), [["SKILL.md", "skill"]]);
});

test("copies a directory source whole", async () => {
  const { send } = fakeSend({
    [`/repos/o/r/contents/?ref=${COMMIT}`]: json([{ path: "skill", type: "dir", sha: "t1" }]),
    "/repos/o/r/git/trees/t1?recursive=1": json({ truncated: false, tree: [
      { path: "SKILL.md", type: "blob", mode: "100644", sha: "s1" },
      { path: "references", type: "tree", mode: "040000", sha: "t2" },
      { path: "references/run.sh", type: "blob", mode: "100755", sha: "s2" },
    ] }),
    "/repos/o/r/git/blobs/s1": blob("skill"),
    "/repos/o/r/git/blobs/s2": blob("run"),
  });
  const files = await new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "skill");
  assert.deepEqual([...files.keys()], ["SKILL.md", "references/run.sh"]);
});

for (const [label, listing, tree, message] of [
  ["a missing path", [], null, /skill does not exist/],
  ["a symlink path", [{ path: "skill", type: "symlink", sha: "x" }], null, /symlink entries are not copied/],
  ["a truncated tree", [{ path: "skill", type: "dir", sha: "t1" }], { truncated: true, tree: [] }, /truncated/],
  ["a symlink inside", [{ path: "skill", type: "dir", sha: "t1" }], { truncated: false, tree: [{ path: "a", type: "blob", mode: "120000", sha: "x" }] }, /symlinks and submodules/],
  ["a submodule inside", [{ path: "skill", type: "dir", sha: "t1" }], { truncated: false, tree: [{ path: "a", type: "commit", mode: "160000", sha: "x" }] }, /symlinks and submodules/],
  ["no SKILL.md", [{ path: "skill", type: "dir", sha: "t1" }], { truncated: false, tree: [] }, /has no SKILL\.md/],
]) {
  test(`rejects ${label}`, async () => {
    const routes = { [`/repos/o/r/contents/?ref=${COMMIT}`]: json(listing) };
    if (tree) routes["/repos/o/r/git/trees/t1?recursive=1"] = json(tree);
    const { send } = fakeSend(routes);
    await assert.rejects(new GitHubSource({ send, apiUrl: API }).files("o/r", COMMIT, "skill"), message);
  });
}

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
