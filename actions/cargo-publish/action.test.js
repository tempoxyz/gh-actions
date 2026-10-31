const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const lib = require("./publish.cjs");

const pkg = (name, deps = [], extra = {}) => ({
  id: "path+file:///ws/" + name + "#" + name + "@1.0.0",
  name,
  version: "1.0.0",
  publish: null,
  dependencies: deps.map(([dep, kind = null, p = "/ws/" + dep]) => ({ name: dep, kind, path: p })),
  ...extra,
});
const meta = (...packages) => ({ packages, workspace_members: packages.map((p) => p.id) });

test("orders workspace packages after their normal and build dependencies", () => {
  const m = meta(
    pkg("app", [["core"], ["macros", "build"], ["serde", null, undefined]]),
    pkg("core", [["macros"], ["testkit", "dev"]]),
    pkg("macros"),
    pkg("testkit", [["core"]]),
  );
  assert.deepEqual(lib.planPackages(m).map((p) => p.name), ["macros", "core", "app", "testkit"]);
});

test("skips publish = false members and honours packages and exclude", () => {
  const m = meta(pkg("a"), pkg("b", [["a"]]), pkg("private", [], { publish: [] }), pkg("other", [], { publish: ["my-registry"] }));
  assert.deepEqual(lib.planPackages(m).map((p) => p.name), ["a", "b"]);
  assert.deepEqual(lib.planPackages(m, { packages: ["b"] }).map((p) => p.name), ["b"]);
  assert.deepEqual(lib.planPackages(m, { exclude: ["a"] }).map((p) => p.name), ["b"]);
  assert.throws(() => lib.planPackages(m, { packages: ["private"] }), /not publishable/);
  assert.throws(() => lib.planPackages(m, { packages: ["missing"] }), /not a workspace member/);
  assert.throws(() => lib.planPackages(m, { packages: ["a;rm -rf /"] }), /invalid package name/);
});

test("rejects a published package that depends on an unpublishable member", () => {
  const m = meta(pkg("a", [["private"]]), pkg("private", [], { publish: [] }));
  assert.throws(() => lib.planPackages(m), /depends on private/);
  const devOnly = meta(pkg("a", [["private", "dev"]]), pkg("private", [], { publish: [] }));
  assert.deepEqual(lib.planPackages(devOnly).map((p) => p.name), ["a"]);
});

test("reports dependency cycles", () => {
  assert.throws(() => lib.planPackages(meta(pkg("a", [["b"]]), pkg("b", [["a"]]))), /cycle between: a, b/);
});

test("builds sparse index paths", () => {
  assert.equal(lib.indexPath("a"), "1/a");
  assert.equal(lib.indexPath("ab"), "2/ab");
  assert.equal(lib.indexPath("abc"), "3/a/abc");
  assert.equal(lib.indexPath("Alloy-Primitives"), "al/lo/alloy-primitives");
});

test("reads published versions from the index and treats 404 as unpublished", async () => {
  const fake = async (url) =>
    url.endsWith("/al/lo/alloy")
      ? { ok: true, status: 200, text: async () => '{"name":"alloy","vers":"1.0.0"}\n{"name":"alloy","vers":"1.1.0"}\n' }
      : { ok: false, status: 404 };
  assert.deepEqual([...(await lib.publishedVersions("alloy", fake))], ["1.0.0", "1.1.0"]);
  assert.equal((await lib.publishedVersions("nope", fake)).size, 0);
});

test("waits as long as crates.io asks after a rate limit", () => {
  const now = Date.parse("Sat, 31 Oct 2026 06:00:00 GMT");
  const out = "error: failed to publish to registry at https://crates.io\n\nCaused by:\n  the remote server responded with an error (status 429 Too Many Requests): You have published too many versions of this crate in a short period of time. Please try again after Sat, 31 Oct 2026 06:01:00 GMT or email help@crates.io to have your limit increased.";
  assert.equal(lib.rateLimitDelayMs(out, 1, now), 65000);
  assert.equal(lib.rateLimitDelayMs("status 429 Too Many Requests", 2, now), 120000);
  assert.equal(lib.rateLimitDelayMs("status 429", 9, now), 600000);
  assert.equal(lib.rateLimitDelayMs("error: failed to verify package tarball", 1, now), null);
  assert.ok(lib.alreadyUploaded("crate version \`1.0.0\` is already uploaded"));
  assert.ok(lib.alreadyUploaded("error: crate foo@1.0.0 already exists on crates.io index"));
});

test("action authenticates only through the pinned trusted publishing action", async () => {
  const action = await readFile(path.join(__dirname, "action.yml"), "utf8");
  assert.match(action, /using: "composite"/);
  assert.match(action, /uses: tempoxyz\/gh-actions\/vendor\/rust-lang\/crates-io-auth-action@[0-9a-f]{40} # /);
  assert.match(action, /CARGO_REGISTRY_TOKEN: \$\{\{ steps\.auth\.outputs\.token \}\}/);
  assert.match(action, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  // Inputs reach scripts only through env, never interpolated into run: blocks.
  for (const block of action.split(/\n\s+run: /).slice(1)) {
    assert.doesNotMatch(block.split("\n")[0], /\$\{\{/);
  }
  assert.doesNotMatch(action, /secrets\.|CARGO_REGISTRY_TOKEN: \$\{\{ secrets/);
});

test("plans and dry-runs a real workspace", { skip: spawnSync("cargo", ["--version"]).status !== 0 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cargo-publish-"));
  try {
    const crate = async (name, deps = "") => {
      await mkdir(path.join(dir, name, "src"), { recursive: true });
      await writeFile(path.join(dir, name, "Cargo.toml"),
        '[package]\nname = "' + name + '"\nversion = "0.1.0"\nedition = "2021"\nlicense = "MIT"\ndescription = "test"\n' + deps);
      await writeFile(path.join(dir, name, "src", "lib.rs"), "");
    };
    await writeFile(path.join(dir, "Cargo.toml"), '[workspace]\nmembers = ["zz-base", "aa-top", "hidden"]\nresolver = "2"\n');
    await crate("zz-base");
    await crate("aa-top", '[dependencies]\nzz-base = { path = "../zz-base", version = "0.1.0" }\n');
    await crate("hidden", "publish = false\n");
    const outFile = path.join(dir, "out");
    await writeFile(outFile, "");
    const env = { ...process.env, GITHUB_OUTPUT: outFile, INPUT_PACKAGES: "", INPUT_EXCLUDE: "", INPUT_SKIP_PUBLISHED: "false" };
    const res = spawnSync("node", [path.join(__dirname, "publish.cjs"), "plan"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const out = await readFile(outFile, "utf8");
    assert.match(out, /packages<<\S+\nzz-base aa-top\n/);
    const plan = JSON.parse(out.match(/plan<<(\S+)\n(.*)\n\1/)[2]);

    const dry = spawnSync("node", [path.join(__dirname, "publish.cjs"), "publish"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PLAN: JSON.stringify(plan), INPUT_DRY_RUN: "true", INPUT_LOCKED: "false", INPUT_DELAY_SECONDS: "0", INPUT_RATE_LIMIT_RETRIES: "0", CARGO_REGISTRY_TOKEN: "" },
    });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout + dry.stderr, /Uploading zz-base[\s\S]*Uploading aa-top/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("publish refuses to run without a token", () => {
  const res = spawnSync("node", [path.join(__dirname, "publish.cjs"), "publish"], {
    encoding: "utf8",
    env: { ...process.env, PLAN: '[{"name":"a","version":"1.0.0"}]', INPUT_DRY_RUN: "false", INPUT_LOCKED: "true", INPUT_DELAY_SECONDS: "0", INPUT_RATE_LIMIT_RETRIES: "1", CARGO_REGISTRY_TOKEN: "" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no crates\.io token/);
});
