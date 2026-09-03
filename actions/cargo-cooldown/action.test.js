const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  checkPackages,
  classifyPackages,
  crateIndexPath,
  parseAllowlist,
  publicationTimes,
  sparseCachePublicationTimes,
} = require("./main.js");

const actionPath = path.join(__dirname, "action.yml");
const mainPath = path.join(__dirname, "main.js");
const readmePath = path.join(__dirname, "README.md");
const oldRelease = "2025-01-01T00:00:00Z";

function options(allowlist = { exact: new Set(), packageDays: new Map() }) {
  return {
    allowlist,
    cargoHome: "/unused-in-tests",
    cooldownDays: 7,
    now: Date.parse("2026-09-03T00:00:00Z"),
    verbose: false,
  };
}

function remoteEntry(crate, version, pubtime = oldRelease) {
  return JSON.stringify({ name: crate, vers: version, pubtime });
}

function sparseCache(crate, entries, cacheFormat = 3, indexFormat = 2) {
  const header = Buffer.alloc(5);
  header[0] = cacheFormat;
  header.writeUInt32LE(indexFormat, 1);
  const fields = ['etag: "fixture"'];
  for (const entry of entries) fields.push(entry.vers, remoteEntry(crate, entry.vers, entry.pubtime));
  return Buffer.concat([header, Buffer.from(`${fields.join("\0")}\0`)]);
}

test("action is first-party Node code with no downloaded executable", async () => {
  const [action, main] = await Promise.all([
    readFile(actionPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  assert.match(action, /using: "node24"/);
  assert.match(action, /main: "main\.js"/);
  assert.doesNotMatch(action, /NomicFoundation|curl|cargo install/);
  assert.doesNotMatch(main, /require\(["'](?!node:|\.\/)/);
});

test("crate index paths follow the sparse registry layout", () => {
  assert.equal(crateIndexPath("a"), "1/a");
  assert.equal(crateIndexPath("ab"), "2/ab");
  assert.equal(crateIndexPath("abc"), "3/a/abc");
  assert.equal(crateIndexPath("Serde"), "se/rd/serde");
});

test("allowlist supports exact exceptions and package-specific days", () => {
  const allowlist = parseAllowlist(`
    # Narrow bootstrap exception
    [[allow.exact]]
    crate = "fresh"
    version = "1.2.3"

    [[allow.package]]
    crate = 'internal'
    days = 1 # shorter policy
  `);

  assert.deepEqual([...allowlist.exact], ["fresh@1.2.3"]);
  assert.equal(allowlist.packageDays.get("internal"), 1);
});

test("malformed allowlists fail closed", () => {
  assert.throws(() => parseAllowlist("[[allow.exact]]\ncrate = \"missing-version\""), /requires crate and version/);
  assert.throws(() => parseAllowlist("[[allow.package]]\ncrate = \"x\"\ndays = soon"), /whole number/);
});

test("publication timestamps are read from index JSON lines", () => {
  const versions = publicationTimes("demo", [
    remoteEntry("demo", "1.0.0", "2026-01-01T00:00:00Z"),
    remoteEntry("demo", "1.1.0", "2026-02-01T00:00:00Z"),
  ].join("\n"));
  assert.equal(versions.get("1.1.0"), "2026-02-01T00:00:00Z");
});

test("remote index identity mismatches fail closed", () => {
  assert.throws(
    () => publicationTimes("expected", remoteEntry("different", "1.0.0")),
    /identity mismatch/,
  );
});

test("Cargo sparse-index cache entries are parsed", () => {
  const versions = sparseCachePublicationTimes("demo", sparseCache("demo", [
    { vers: "1.0.0", pubtime: "2026-01-01T00:00:00Z" },
    { vers: "1.1.0", pubtime: "2026-02-01T00:00:00Z" },
  ]));
  assert.equal(versions.get("1.1.0"), "2026-02-01T00:00:00Z");
});

test("unsupported and malformed Cargo cache formats are rejected", () => {
  assert.throws(() => sparseCachePublicationTimes("demo", sparseCache("demo", [], 4)), /unsupported/);
  assert.throws(() => sparseCachePublicationTimes("demo", sparseCache("demo", [], 3, 99)), /unsupported/);
  assert.throws(() => sparseCachePublicationTimes("demo", Buffer.from([3, 2, 0, 0, 0, 0])), /malformed/);
});

test("checker uses Cargo cache without a remote request", async () => {
  const result = await checkPackages(
    [{ name: "cached", version: "1.2.3" }],
    options(),
    {
      readCachedPublicationTimes: async () => new Map([["1.2.3", oldRelease]]),
      fetchIndex: async () => { throw new Error("remote lookup must not run"); },
    },
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.stats, {
    cacheHits: 1,
    checkedPackages: 1,
    exemptions: 0,
    remoteFallbacks: 0,
    uniqueCrates: 1,
  });
});

test("cache misses and malformed cache entries fall back remotely", async () => {
  let remoteRequests = 0;
  const result = await checkPackages(
    [{ name: "fallback", version: "1.2.3" }],
    options(),
    {
      readCachedPublicationTimes: async () => { throw new Error("unsupported cache format"); },
      fetchIndex: async () => {
        remoteRequests += 1;
        return remoteEntry("fallback", "1.2.3");
      },
    },
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.stats.remoteFallbacks, 1);
  assert.equal(remoteRequests, 1);
});

test("checker rejects fresh crates", async () => {
  const result = await checkPackages(
    [{ name: "fresh", version: "1.2.3" }],
    options(),
    {
      readCachedPublicationTimes: async () => new Map(),
      fetchIndex: async () => remoteEntry("fresh", "1.2.3", "2026-09-01T00:00:00Z"),
    },
  );
  assert.equal(result.violations.length, 1);
});

test("exact and zero-day exceptions do not read cache or network", async () => {
  const allowlist = {
    exact: new Set(["fresh@1.2.3"]),
    packageDays: new Map([["trusted", 0]]),
  };
  const result = await checkPackages(
    [
      { name: "fresh", version: "1.2.3" },
      { name: "trusted", version: "4.5.6" },
    ],
    options(allowlist),
    {
      readCachedPublicationTimes: async () => { throw new Error("cache lookup must not run"); },
      fetchIndex: async () => { throw new Error("remote lookup must not run"); },
    },
  );
  assert.deepEqual(result.violations, []);
  assert.equal(result.stats.checkedPackages, 0);
  assert.equal(result.stats.exemptions, 2);
});

test("missing, invalid, and unavailable publication evidence fails closed", async () => {
  const pkg = [{ name: "unknown", version: "9.9.9" }];
  const noCache = { readCachedPublicationTimes: async () => new Map() };
  await assert.rejects(
    checkPackages(pkg, options(), { ...noCache, fetchIndex: async () => "" }),
    /no publication timestamp/,
  );
  await assert.rejects(
    checkPackages(pkg, options(), { ...noCache, fetchIndex: async () => remoteEntry("unknown", "9.9.9", "not-a-date") }),
    /invalid publication timestamp/,
  );
  await assert.rejects(
    checkPackages(pkg, options(), { ...noCache, fetchIndex: async () => { throw new Error("index unavailable"); } }),
    /index unavailable/,
  );
});

test("only known crates.io sources, local packages, and Git packages are accepted", () => {
  const cratesIo = { name: "registry", version: "1.0.0", source: "registry+sparse+https://index.crates.io/" };
  const result = classifyPackages([
    { name: "workspace", version: "0.1.0", source: null },
    { name: "git-dependency", version: "0.2.0", source: "git+https://example.test/repo" },
    cratesIo,
  ]);
  assert.deepEqual(result, { cratesIo: [cratesIo], skipped: 2 });
});

test("unknown registries and source formats fail closed", () => {
  assert.throws(
    () => classifyPackages([{ name: "private", version: "1.0.0", source: "registry+https://packages.example.test/index" }]),
    /unrecognized Cargo source/,
  );
  assert.throws(
    () => classifyPackages([{ name: "future", version: "1.0.0", source: "new-source+https://example.test" }]),
    /unrecognized Cargo source/,
  );
});

test("documentation states cache, scope, seven-day, and fail-closed behavior", async () => {
  const readme = await readFile(readmePath, "utf8");
  assert.match(readme, /defaults to seven/);
  assert.match(readme, /does not download or execute a third-party tool/);
  assert.match(readme, /The action fails closed/);
  assert.match(readme, /Cargo's sparse-index cache/);
  assert.match(readme, /does not protect\s+a later `cargo install`/);
});
