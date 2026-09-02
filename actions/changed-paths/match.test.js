import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, compileFilter, applyFilters } from "./match.mjs";

test("globs: **, *, ?, braces, directory suffix", () => {
  assert.ok(globToRegExp("crates/**").test("crates/a/b/c.rs"));
  assert.ok(globToRegExp("crates/**").test("crates/x"));
  assert.ok(!globToRegExp("crates/**").test("other/crates/x"));
  assert.ok(globToRegExp("crates/**/Cargo.toml").test("crates/precompiles/Cargo.toml"));
  assert.ok(globToRegExp("crates/**/Cargo.toml").test("crates/Cargo.toml"));
  assert.ok(globToRegExp("*.md").test("README.md"));
  assert.ok(!globToRegExp("*.md").test("docs/README.md"));
  assert.ok(globToRegExp("src/**/*.{ts,tsx}").test("src/a/b.tsx"));
  assert.ok(globToRegExp("docs/").test("docs/x/y.md"));
  assert.ok(globToRegExp("file?.txt").test("file1.txt"));
});

test("negated patterns exclude", () => {
  const m = compileFilter(["crates/contracts/**", "!crates/contracts/CHANGELOG.md", "!crates/contracts/Cargo.toml"]);
  assert.equal(m("crates/contracts/src/lib.rs"), true);
  assert.equal(m("crates/contracts/CHANGELOG.md"), false);
  assert.equal(m("crates/contracts/Cargo.toml"), false);
  assert.equal(m("crates/other/lib.rs"), false);
});

test("applyFilters reports matches per filter", () => {
  const r = applyFilters({ specs: ["tips/verify/**", ".github/workflows/specs.yml"], smoke: ["Cargo.lock"] },
    ["tips/verify/a.md", "README.md", ".github/workflows/specs.yml"]);
  assert.deepEqual(r.specs.matched, ["tips/verify/a.md", ".github/workflows/specs.yml"]);
  assert.deepEqual(r.smoke.matched, []);
});
