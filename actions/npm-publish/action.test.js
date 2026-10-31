const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const lib = require("./publish.cjs");
const script = path.join(__dirname, "publish.cjs");
const has = (cmd) => spawnSync(cmd, ["--version"]).status === 0;

const pkg = (name, deps = {}, extra = {}) => ({ name, version: "1.0.0", dir: "/" + name, manifest: { name, version: "1.0.0", ...deps, ...extra } });

test("orders packages after their runtime dependencies, ignoring devDependencies", () => {
  const order = lib.orderPackages([
    pkg("app", { dependencies: { core: "1.0.0", react: "^18" }, devDependencies: { testkit: "1.0.0" } }),
    pkg("core", { peerDependencies: { types: "1.0.0" } }),
    pkg("types"),
    pkg("testkit", { dependencies: { app: "1.0.0" } }),
  ]).map((p) => p.name);
  assert.deepEqual(order, ["types", "core", "app", "testkit"]);
  assert.throws(() => lib.orderPackages([pkg("a", { dependencies: { b: "1" } }), pkg("b", { dependencies: { a: "1" } })]), /cycle between: a, b/);
});

test("reads published versions and treats 404 as unpublished", async () => {
  const fake = async (url) => url.endsWith("/@tempoxyz%2fid")
    ? { ok: true, status: 200, json: async () => ({ versions: { "0.0.1": {}, "0.0.2": {} } }) }
    : { ok: false, status: 404 };
  assert.deepEqual([...(await lib.publishedVersions("@tempoxyz/id", fake))], ["0.0.1", "0.0.2"]);
  assert.equal((await lib.publishedVersions("nope", fake)).size, 0);
});

test("requires npm 11.5.1 for trusted publishing", () => {
  assert.ok(lib.supportsTrustedPublishing("11.5.1"));
  assert.ok(lib.supportsTrustedPublishing("12.0.0"));
  assert.ok(!lib.supportsTrustedPublishing("11.5.0"));
  assert.ok(!lib.supportsTrustedPublishing("10.9.2"));
});

test("finds stored npm tokens but accepts environment placeholders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmrc-"));
  const ok = path.join(dir, "ok"), bad = path.join(dir, "bad"), commented = path.join(dir, "c");
  fs.writeFileSync(ok, "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nalways-auth=true\n");
  fs.writeFileSync(bad, "//registry.npmjs.org/:_authToken=npm_abc123\n");
  fs.writeFileSync(commented, "# //registry.npmjs.org/:_authToken=npm_abc123\n");
  assert.deepEqual(lib.storedTokenFiles([ok, bad, commented, path.join(dir, "missing")]), [bad]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("extracts the changelog section for a version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chlog-"));
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# x\n\n## 1.1.0\n\n### Minor Changes\n\n- feat\n\n## 1.0.0\n\n- first\n");
  assert.equal(lib.changelogSection(dir, "1.1.0"), "### Minor Changes\n\n- feat");
  assert.equal(lib.changelogSection(dir, "1.0.0"), "- first");
  assert.equal(lib.changelogSection(dir, "2.0.0"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(pm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-" + pm + "-"));
  const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), typeof data === "string" ? data : JSON.stringify(data, null, 2)); };
  const spec = pm === "pnpm" ? "workspace:^" : "1.2.3";
  write("package.json", { name: "root", version: "0.0.0", ...(pm === "npm" ? { workspaces: ["packages/*"] } : {}) });
  if (pm === "pnpm") write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("packages/zz-core/package.json", { name: "@tempo-test/zz-core", version: "1.2.3", license: "MIT" });
  write("packages/zz-core/index.js", "module.exports = 1;\n");
  write("packages/zz-core/CHANGELOG.md", "# core\n\n## 1.2.3\n\n- fixed things\n");
  write("packages/aa-app/package.json", { name: "@tempo-test/aa-app", version: "0.1.0", license: "MIT", dependencies: { "@tempo-test/zz-core": spec } });
  write("packages/aa-app/index.js", "module.exports = 2;\n");
  write("packages/hidden/package.json", { name: "hidden", version: "1.0.0", private: true });
  const install = spawnSync(pm, ["install"], { cwd: dir, encoding: "utf8" });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  return dir;
}

for (const pm of ["pnpm", "npm"]) {
  test(pm + " workspace: packs in order, rewrites workspace deps and dry-run publishes", { skip: !has(pm) }, () => {
    const dir = workspace(pm);
    const packDir = path.join(dir, "out");
    const out = path.join(dir, "gh-out");
    fs.writeFileSync(out, "");
    try {
      const env = { ...process.env, GITHUB_OUTPUT: out, PACK_DIRECTORY: packDir, INPUT_PACKAGES: "", INPUT_PACKAGE_MANAGER: "auto", INPUT_SKIP_PUBLISHED: "true", INPUT_DRY_RUN: "true" };
      const packed = spawnSync("node", [script, "pack"], { cwd: dir, env, encoding: "utf8" });
      assert.equal(packed.status, 0, packed.stdout + packed.stderr);
      const plan = JSON.parse(fs.readFileSync(path.join(packDir, "plan.json"), "utf8")).packages;
      assert.deepEqual(plan.map((p) => p.name), ["@tempo-test/zz-core", "@tempo-test/aa-app"]);
      assert.equal(plan[0].notes, "- fixed things");
      const app = JSON.parse(spawnSync("tar", ["-xOzf", path.join(packDir, plan[1].file), "package/package.json"], { encoding: "utf8" }).stdout);
      assert.equal(app.dependencies["@tempo-test/zz-core"], pm === "pnpm" ? "^1.2.3" : "1.2.3");

      const published = spawnSync("node", [script, "publish"], {
        cwd: dir, encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: out, PACK_DIRECTORY: packDir, INPUT_DRY_RUN: "true", INPUT_ACCESS: "public", INPUT_PROVENANCE: "auto", INPUT_DIST_TAG: "next", REPOSITORY_VISIBILITY: "private" },
      });
      assert.equal(published.status, 0, published.stdout + published.stderr);
      assert.match(published.stdout, /@tempo-test\/zz-core@1\.2\.3[\s\S]*@tempo-test\/aa-app@0\.1\.0/);
      assert.match(fs.readFileSync(out, "utf8"), /published<<\S+\n\[\{"name":"@tempo-test\/zz-core","version":"1\.2\.3"\},\{"name":"@tempo-test\/aa-app","version":"0\.1\.0"\}\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("publish refuses a tarball that does not match the plan or keeps workspace specifiers", { skip: !has("npm") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-bad-"));
  try {
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "pkg", "package.json"), JSON.stringify({ name: "evil", version: "9.9.9", dependencies: { x: "workspace:*" } }));
    assert.equal(spawnSync("npm", ["pack", "--pack-destination", dir], { cwd: path.join(dir, "pkg") }).status, 0);
    const file = path.join(dir, "evil-9.9.9.tgz");
    assert.throws(() => lib.checkTarball(file, { name: "good", version: "1.0.0" }), /holds evil@9\.9\.9, not good@1\.0\.0/);
    assert.throws(() => lib.checkTarball(file, { name: "evil", version: "9.9.9" }), /local dependency specifiers: dependencies\.x = workspace:\*/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publish checks trusted publishing prerequisites before uploading", { skip: !has("npm") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-pre-"));
  try {
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "pkg", "package.json"), JSON.stringify({ name: "ok-pkg", version: "1.0.0" }));
    spawnSync("npm", ["pack", "--pack-destination", dir], { cwd: path.join(dir, "pkg") });
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ packages: [{ name: "ok-pkg", version: "1.0.0", file: "ok-pkg-1.0.0.tgz" }] }));
    const base = { ...process.env, PACK_DIRECTORY: dir, INPUT_DRY_RUN: "false", INPUT_ACCESS: "public", INPUT_PROVENANCE: "auto" };
    delete base.ACTIONS_ID_TOKEN_REQUEST_URL;
    const selfHosted = spawnSync("node", [script, "publish"], { cwd: dir, encoding: "utf8", env: { ...base, RUNNER_ENVIRONMENT: "self-hosted" } });
    assert.equal(selfHosted.status, 1);
    assert.match(selfHosted.stdout, /only on GitHub-hosted runners/);
    const noOidc = spawnSync("node", [script, "publish"], { cwd: dir, encoding: "utf8", env: { ...base, RUNNER_ENVIRONMENT: "github-hosted" } });
    assert.equal(noOidc.status, 1);
    assert.match(noOidc.stdout, /id-token: write/);
    const userrc = path.join(dir, "userrc");
    fs.writeFileSync(userrc, "//registry.npmjs.org/:_authToken=npm_secret\n");
    const stored = spawnSync("node", [script, "publish"], { cwd: dir, encoding: "utf8", env: { ...base, RUNNER_ENVIRONMENT: "github-hosted", ACTIONS_ID_TOKEN_REQUEST_URL: "http://x", NPM_CONFIG_USERCONFIG: userrc } });
    assert.equal(stored.status, 1);
    assert.match(stored.stdout, /stored npm token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("action passes inputs only through env", () => {
  const action = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  assert.match(action, /using: "composite"/);
  for (const block of action.split(/\n\s+run: /).slice(1)) assert.doesNotMatch(block.split("\n")[0], /\$\{\{/);
  assert.doesNotMatch(action, /secrets\.|NPM_TOKEN: \$\{\{/);
  assert.match(action, /RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}/);
});

test("a workspace root is never planned, even when not private", { skip: !has("pnpm") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-root-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "repo-root", version: "1.0.0" }));
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    fs.mkdirSync(path.join(dir, "packages", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "lib", "package.json"), JSON.stringify({ name: "lib", version: "1.0.0" }));
    assert.equal(spawnSync("pnpm", ["install"], { cwd: dir }).status, 0);
    assert.ok(lib.isWorkspace(dir));
    assert.deepEqual(lib.discoverPackages(dir, "pnpm").map((d) => path.basename(d)), ["lib"]);
    const single = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-single-"));
    fs.writeFileSync(path.join(single, "package.json"), JSON.stringify({ name: "single", version: "1.0.0" }));
    assert.ok(!lib.isWorkspace(single));
    assert.deepEqual(lib.discoverPackages(single, "npm"), [single]);
    fs.rmSync(single, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prereleases use the Changesets pre tag and are refused without one", { skip: !has("npm") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-pre-mode-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@tempo-test/beta-pkg", version: "1.2.0-beta.0", publishConfig: { access: "restricted" } }));
    const out = path.join(dir, "o");
    const run = (extra) => {
      fs.writeFileSync(out, "");
      return spawnSync("node", [script, "pack"], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out, PACK_DIRECTORY: path.join(dir, "out"), INPUT_SKIP_PUBLISHED: "false", INPUT_DRY_RUN: "false", INPUT_DIST_TAG: "", ...extra } });
    };
    const refused = run({});
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /prerelease, but no dist-tag/);
    fs.mkdirSync(path.join(dir, ".changeset"));
    fs.writeFileSync(path.join(dir, ".changeset", "pre.json"), JSON.stringify({ mode: "pre", tag: "beta" }));
    assert.equal(lib.changesetsPreTag(dir), "beta");
    const packed = run({});
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, "out", "plan.json"), "utf8"));
    assert.equal(plan.packages[0].tag, "beta");
    assert.equal(plan.singlePackage, true);
    // No --access unless asked: the dry run must not override publishConfig.access.
    const dry = spawnSync("node", [script, "publish"], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out, PACK_DIRECTORY: path.join(dir, "out"), INPUT_DRY_RUN: "true", INPUT_ACCESS: "", INPUT_PROVENANCE: "false", INPUT_DIST_TAG: "" } });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout + dry.stderr, /restricted access/);
    assert.match(dry.stdout + dry.stderr, /tag beta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("released leaves out versions pack found already on npm", { skip: !has("npm") }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-released-"));
  try {
    fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ packages: [], onNpm: [{ name: "a", version: "1.0.0", notes: "" }], singlePackage: false }));
    const out = path.join(dir, "o");
    fs.writeFileSync(out, "");
    const res = spawnSync("node", [script, "publish"], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: out, PACK_DIRECTORY: dir, INPUT_DRY_RUN: "false" } });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(fs.readFileSync(out, "utf8"), /released<<\S+\n\[\]\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pnpm-workspace.yaml counts as a workspace only when pnpm lists member projects", { skip: !has("pnpm") }, () => {
  const make = (yaml) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-pnpm-ws-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "root-pkg", version: "1.0.0" }));
    fs.mkdirSync(path.join(dir, "packages", "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "packages", "lib", "package.json"), JSON.stringify({ name: "lib", version: "1.0.0" }));
    fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), yaml);
    return dir;
  };
  const cases = [
    ["onlyBuiltDependencies:\n  - esbuild\n", false],
    ["packages:\n- 'packages/*'\n", true],
    ["packages: [\n  'packages/*',\n]\n", true],
    ["packages:\n  - packages/*\nonlyBuiltDependencies:\n  - x\n", true],
  ];
  for (const [yaml, expected] of cases) {
    const dir = make(yaml);
    try {
      assert.equal(lib.isWorkspace(dir), expected, yaml);
      assert.deepEqual(lib.discoverPackages(dir, "pnpm").map((d) => path.basename(d)), expected ? ["lib"] : [path.basename(dir)], yaml);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
