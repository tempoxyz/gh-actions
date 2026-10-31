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

test("publishes versioned dev-dependencies first, unless that would form a cycle", () => {
  const ver = (dep) => ({ name: dep, kind: "dev", path: "/ws/" + dep, req: "^1.0.0" });
  const pathOnly = (dep) => ({ name: dep, kind: "dev", path: "/ws/" + dep, req: "*" });
  const a = pkg("a"); a.dependencies.push(ver("b"));
  assert.deepEqual(lib.planPackages(meta(a, pkg("b"))).map((p) => p.name), ["b", "a"]);
  const a2 = pkg("a"); a2.dependencies.push(pathOnly("b"));
  assert.deepEqual(lib.planPackages(meta(a2, pkg("b"))).map((p) => p.name), ["a", "b"]);
  // core <-dev- testkit -normal-> core: the dev edge yields to the real dependency.
  const core = pkg("core"); core.dependencies.push(ver("testkit"));
  assert.deepEqual(lib.planPackages(meta(core, pkg("testkit", [["core"]]))).map((p) => p.name), ["core", "testkit"]);
});

test("drops dev-dependency edges only on a cycle", () => {
  const ver = (dep) => ({ name: dep, kind: "dev", path: "/ws/" + dep, req: "^1.0.0" });
  // aa dev-depends on new crate zz (no cycle); core/testkit form a dev cycle. aa sorts first, but
  // must still wait for zz.
  const aa = pkg("aa"); aa.dependencies.push(ver("zz"));
  const core = pkg("core"); core.dependencies.push(ver("testkit"));
  const order = lib.planPackages(meta(aa, pkg("zz", [["core"]]), core, pkg("testkit", [["core"]]))).map((p) => p.name);
  assert.ok(order.indexOf("zz") < order.indexOf("aa"), order.join(","));
  assert.ok(order.indexOf("core") < order.indexOf("testkit"), order.join(","));
  // Two crates dev-depending on each other: one goes first.
  const x = pkg("x"); x.dependencies.push(ver("y"));
  const y = pkg("y"); y.dependencies.push(ver("x"));
  assert.deepEqual(lib.planPackages(meta(x, y)).map((p) => p.name), ["x", "y"]);
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

test("classifies only crates.io's registry answer, never build output", () => {
  const now = Date.parse("Sat, 31 Oct 2026 06:00:00 GMT");
  const limited = "error: failed to publish foo v1.0.0 to registry at https://crates.io\n\nCaused by:\n  the remote server responded with an error (status 429 Too Many Requests): You have published too many versions of this crate in a short period of time. Please try again after Sat, 31 Oct 2026 06:01:00 GMT or email help@crates.io to have your limit increased.";
  assert.equal(lib.rateLimitDelayMs(limited, 1, now), 65000);
  const noTime = "Caused by:\n  the remote server responded with an error (status 429 Too Many Requests): slow down";
  assert.equal(lib.rateLimitDelayMs(noTime, 2, now), 120000);
  assert.equal(lib.rateLimitDelayMs(noTime, 9, now), 600000);
  // Compile and verification failures that merely mention 429, rate limits or "already exists".
  const build = "   Compiling foo v1.0.429\nerror[E0425]: cannot find value `rate_limit` (status 429)\nerror: file already exists\nerror: failed to verify package tarball";
  assert.equal(lib.rateLimitDelayMs(build, 1, now), null);
  assert.equal(lib.alreadyUploaded(build, "foo", "1.0.429"), false);
  assert.equal(lib.registryError(build), "");
  assert.ok(lib.alreadyUploaded("error: crate foo@1.0.0 already exists on crates.io index", "foo", "1.0.0"));
  assert.ok(lib.alreadyUploaded("\x1b[1m\x1b[91merror\x1b[0m\x1b[1m:\x1b[0m crate foo@1.0.0 already exists on crates.io index", "foo", "1.0.0"));
  assert.ok(!lib.alreadyUploaded("error: crate foo@1.0.0 already exists on crates.io index", "foo-bar", "1.0.0"));
  assert.ok(lib.alreadyUploaded("Caused by:\n  the remote server responded with an error (status 400 Bad Request): crate version `1.0.0` is already uploaded", "foo", "1.0.0"));
  assert.ok(!lib.alreadyUploaded("Caused by:\n  the remote server responded with an error (status 400 Bad Request): missing description", "foo", "1.0.0"));
});

test("action authenticates only through the pinned trusted publishing action", async () => {
  const action = await readFile(path.join(__dirname, "action.yml"), "utf8");
  assert.match(action, /using: "composite"/);
  assert.match(action, /uses: tempoxyz\/gh-actions\/vendor\/rust-lang\/crates-io-auth-action@[0-9a-f]{40} # /);
  assert.match(action, /CARGO_REGISTRY_TOKEN: \$\{\{ steps\.auth\.outputs\.token \}\}/);
  assert.match(action, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(action, /TOKEN_ISSUED_AT: \$\{\{ steps\.issued\.outputs\.at \}\}/);
  assert.match(action.split("id: plan")[1].split("- name:")[0], /INPUT_DRY_RUN/);
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

    // A dry run checks every package even when skip-published is on.
    await writeFile(outFile, "");
    const dryPlan = spawnSync("node", [path.join(__dirname, "publish.cjs"), "plan"], {
      cwd: dir, encoding: "utf8",
      env: { ...env, INPUT_SKIP_PUBLISHED: "true", INPUT_DRY_RUN: "true", PATH: process.env.PATH },
    });
    assert.equal(dryPlan.status, 0, dryPlan.stdout + dryPlan.stderr);
    assert.match(await readFile(outFile, "utf8"), /packages<<\S+\nzz-base aa-top\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stops before an upload the token would not outlive", () => {
  const res = spawnSync("node", [path.join(__dirname, "publish.cjs"), "publish"], {
    encoding: "utf8",
    env: { ...process.env, PLAN: '[{"name":"a","version":"1.0.0"}]', INPUT_DRY_RUN: "false", INPUT_LOCKED: "true", INPUT_DELAY_SECONDS: "0", INPUT_RATE_LIMIT_RETRIES: "1", CARGO_REGISTRY_TOKEN: "x", TOKEN_ISSUED_AT: String(Math.floor(Date.now() / 1000) - 26 * 60) },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /stopping before a@1\.0\.0: the crates\.io token expires soon/);
});

test("publish refuses to run without a token", () => {
  const res = spawnSync("node", [path.join(__dirname, "publish.cjs"), "publish"], {
    encoding: "utf8",
    env: { ...process.env, PLAN: '[{"name":"a","version":"1.0.0"}]', INPUT_DRY_RUN: "false", INPUT_LOCKED: "true", INPUT_DELAY_SECONDS: "0", INPUT_RATE_LIMIT_RETRIES: "1", CARGO_REGISTRY_TOKEN: "" },
  });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no crates\.io token/);
});
