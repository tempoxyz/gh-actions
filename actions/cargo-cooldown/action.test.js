const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  checkPackages,
  classifyPackages,
  crateIndexPath,
  main,
  parseAllowlist,
  parseCargoLock,
  publicationTimes,
  requestIndex,
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
  assert.match(main, /locate-project/);
  for (const command of ["metadata", "fetch", "tree", "generate-lockfile"]) {
    assert.doesNotMatch(main, new RegExp(`["']${command}["']`));
  }
  assert.match(main, /::notice::.*downstream workspace Cargo command must use --locked/);
});

test("main discovers the workspace without running a dependency-resolving Cargo command", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cargo-cooldown-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, ".cargo"));
  await writeFile(path.join(workspace, "Cargo.toml"), "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
  await writeFile(path.join(workspace, "Cargo.lock"), "version = 4\n\n[[package]]\nname = \"fixture\"\nversion = \"0.1.0\"\n");

  const calls = [];
  await main({
    input: (name) => (name === "working-directory" ? workspace : ""),
    now: Date.parse("2026-09-03T00:00:00Z"),
    outputPath: null,
    runCargo: (cwd, args) => {
      calls.push({ cwd, args });
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({ root: path.join(workspace, "Cargo.toml") }),
      };
    },
  });

  assert.deepEqual(calls, [{
    cwd: workspace,
    args: ["locate-project", "--workspace", "--message-format", "json", "--frozen"],
  }]);
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

test("Cargo.lock parser extracts registry, Git, and local package records", () => {
  const packages = parseCargoLock(`
    version = 4

    [[package]]
    name = "workspace"
    version = "0.1.0"

    [[package]]
    name = "registry"
    version = "1.2.3"
    source = "registry+https://github.com/rust-lang/crates.io-index"
    checksum = "abc"

    [[package]]
    name = "git-package"
    version = "2.3.4"
    source = "git+https://example.test/repo#revision"
  `);
  assert.deepEqual(packages, [
    { name: "workspace", version: "0.1.0", source: null },
    { name: "registry", version: "1.2.3", source: "registry+https://github.com/rust-lang/crates.io-index" },
    { name: "git-package", version: "2.3.4", source: "git+https://example.test/repo#revision" },
  ]);
});

test("unsupported and malformed Cargo.lock files fail closed", () => {
  assert.throws(() => parseCargoLock("version = 2\n"), /unsupported Cargo.lock format/);
  assert.throws(() => parseCargoLock("version = 4\n[[package]]\nname = \"missing-version\"\n"), /requires name and version/);
  assert.throws(() => parseCargoLock("version = 4\n[[package]]\nname = 'single-quoted'\nversion = \"1.0.0\"\n"), /malformed package field/);
  assert.throws(() => parseCargoLock("version = 4\n[[package]]\nname = \"one\"\nname = \"two\"\nversion = \"1.0.0\"\n"), /duplicate package name/);
  assert.throws(() => parseCargoLock("version = 4\n[[ package ]]\nname = \"hidden\"\nversion = \"1.0.0\"\n"), /unsupported array table/);
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

test("a failed lookup stops workers from scheduling the rest of the queue", async () => {
  const packages = Array.from({ length: 50 }, (_, index) => ({
    name: `crate${String(index).padStart(2, "0")}`,
    version: "1.0.0",
  }));
  let remoteRequests = 0;
  await assert.rejects(
    checkPackages(packages, options(), {
      readCachedPublicationTimes: async () => new Map(),
      fetchIndex: async (crate, { signal }) => {
        remoteRequests += 1;
        if (crate === "crate00") throw new Error("first lookup failed");
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(remoteEntry(crate, "1.0.0")), 100);
          const abort = () => {
            clearTimeout(timeout);
            reject(new Error("lookup aborted"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    }),
    /first lookup failed/,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(remoteRequests <= 8, `expected at most 8 in-flight requests, got ${remoteRequests}`);
});

test("a response timeout is retried without rejecting successful later attempts", async () => {
  let attempts = 0;
  const body = remoteEntry("retry-demo", "1.0.0");
  const get = (_url, _requestOptions, callback) => {
    attempts += 1;
    const currentAttempt = attempts;
    const request = new EventEmitter();
    const response = new EventEmitter();
    response.statusCode = 200;
    response.setEncoding = () => {};
    response.destroy = (error) => response.emit("error", error);
    request.setTimeout = (_milliseconds, onTimeout) => {
      if (currentAttempt < 3) setImmediate(onTimeout);
    };
    request.destroy = (error) => {
      request.emit("error", error);
      response.emit("error", error);
    };
    process.nextTick(() => {
      callback(response);
      if (currentAttempt === 3) {
        response.emit("data", body);
        response.emit("end");
      }
    });
    return request;
  };

  assert.equal(await requestIndex("retry-demo", { get, sleep: async () => {} }), body);
  assert.equal(attempts, 3);
});

test("aborting an index request does not retry it", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const get = () => {
    attempts += 1;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  const pending = requestIndex("abort-demo", {
    get,
    signal: controller.signal,
    sleep: async () => {},
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
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
  assert.match(readme, /does\s+not download or extract crate archives/);
  assert.match(readme, /downstream Cargo command.*`--locked`/s);
  assert.match(readme, /does not protect\s+a later `cargo install`/);
});
