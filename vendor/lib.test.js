import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny, rewriteUsesText, compareVersions, updateReadmeText, README_BEGIN, README_END } from "./lib.mjs";

test("glob patterns are anchored at the tree root and match whole directories", () => {
  assert.ok(globToRegExp("src/").test("src/index.ts"));
  assert.ok(globToRegExp("src/").test("src"));
  assert.ok(!globToRegExp("src/").test("dist/src/index.js"), "not anchored at depth");
  assert.ok(globToRegExp("**/*.map").test("dist/index.js.map"));
  assert.ok(globToRegExp("**/*.map").test("index.js.map"));
  assert.ok(globToRegExp("*.png").test("logo.png"));
  assert.ok(!globToRegExp("*.png").test("dist/logo.png"), "root-only image pattern");
  assert.ok(globToRegExp("tsconfig*.json").test("tsconfig.build.json"));
  assert.ok(globToRegExp("**").test("anything/at/all"));
  assert.ok(globToRegExp(".github/").test(".github/workflows/ci.yml"));
  assert.equal(matchesAny("LICENSE.md", ["LICENSE*"]), "LICENSE*");
  assert.equal(matchesAny("dist/index.js", ["src/", "**/*.map"]), null);
});

test("nested uses: third-party refs become $/vendor paths, GitHub-authored refs stay or get pinned", () => {
  const text = [
    "runs:",
    "  using: composite",
    "  steps:",
    "    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "    - uses: actions/cache@v4",
    "    - uses: peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1 # v8.1.1",
    "    - uses: 'docker/login-action@v3'",
    "    - uses: ./local",
    "    - uses: $/vendor/x/y",
    "    - uses: docker://alpine:3",
    "    - uses: tempoxyz/gh-actions/actions/github-sts@abc",
  ].join("\n");
  const ctx = { org: "tempoxyz/gh-actions", allowedUpstreams: ["actions/", "github/"], vendored: new Set(["peter-evans/create-pull-request"]), pinNested: { "actions/cache@v4": "0123456789012345678901234567890123456789" } };
  const r = rewriteUsesText(text, ctx);
  assert.deepEqual(r.missing, ["docker/login-action@v3"]);
  assert.deepEqual(r.unpinned, []);
  assert.match(r.text, /uses: \$\/vendor\/peter-evans\/create-pull-request # vendored peter-evans\/create-pull-request@5f6978/);
  assert.match(r.text, /uses: actions\/cache@0123456789012345678901234567890123456789 # actions\/cache@v4/);
  assert.match(r.text, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1/);
  assert.match(r.text, /uses: \.\/local/);
  assert.match(r.text, /uses: docker:\/\/alpine:3/);
  const r2 = rewriteUsesText("    - uses: github/codeql-action/upload-sarif@v3\n", { ...ctx, pinNested: {} });
  assert.deepEqual(r2.unpinned, ["github/codeql-action/upload-sarif@v3"]);
});

test("version comparison prefers numeric order and handles v prefixes", () => {
  assert.deepEqual(["v1.10.0", "v1.9.2", "v2", "1.9.10"].sort(compareVersions), ["v1.9.2", "1.9.10", "v1.10.0", "v2"]);
});

test("README table replaces only the marked block", () => {
  const readme = `# x\n\n${README_BEGIN}\nold\n${README_END}\n\nrest\n`;
  const out = updateReadmeText(readme, "| a |\n|---|");
  assert.equal(out, `# x\n\n${README_BEGIN}\n| a |\n|---|\n${README_END}\n\nrest\n`);
  assert.throws(() => updateReadmeText("no markers", "x"), /markers/);
});
