const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const {
  checkPackages,
  crateIndexPath,
  parseAllowlist,
  publicationTimes,
} = require("./main.js");

const actionPath = path.join(__dirname, "action.yml");
const mainPath = path.join(__dirname, "main.js");
const readmePath = path.join(__dirname, "README.md");

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
    JSON.stringify({ name: "demo", vers: "1.0.0", pubtime: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ name: "demo", vers: "1.1.0", pubtime: "2026-02-01T00:00:00Z" }),
  ].join("\n"));
  assert.equal(versions.get("1.1.0"), "2026-02-01T00:00:00Z");
});

test("checker rejects fresh crates and honors exact exceptions", async () => {
  const packages = [{ name: "fresh", version: "1.2.3" }];
  const fetchIndex = async () => JSON.stringify({
    name: "fresh",
    vers: "1.2.3",
    pubtime: "2026-09-01T00:00:00Z",
  });
  const options = {
    allowlist: { exact: new Set(), packageDays: new Map() },
    cooldownDays: 7,
    now: Date.parse("2026-09-03T00:00:00Z"),
    verbose: false,
  };

  assert.equal((await checkPackages(packages, options, { fetchIndex })).length, 1);
  options.allowlist.exact.add("fresh@1.2.3");
  assert.deepEqual(await checkPackages(packages, options, { fetchIndex }), []);
});

test("missing publication evidence fails closed", async () => {
  await assert.rejects(
    checkPackages(
      [{ name: "unknown", version: "9.9.9" }],
      {
        allowlist: { exact: new Set(), packageDays: new Map() },
        cooldownDays: 7,
        now: Date.now(),
        verbose: false,
      },
      { fetchIndex: async () => "" },
    ),
    /no publication timestamp/,
  );
});

test("documentation states seven-day and fail-closed behavior", async () => {
  const readme = await readFile(readmePath, "utf8");
  assert.match(readme, /defaults to seven/);
  assert.match(readme, /does not download or execute a third-party tool/);
  assert.match(readme, /The action fails closed/);
});
