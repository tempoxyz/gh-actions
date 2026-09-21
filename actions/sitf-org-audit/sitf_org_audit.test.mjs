import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTree, analyzeWorkflow, mapLimit, parseTargets } from "./sitf_org_audit.mjs";

const repo = { full_name: "example/repo" };

test("parseTargets accepts commas and newlines and removes duplicates", () => {
  assert.deepEqual(parseTargets("tempoxyz, paradigmxyz/reth\nalloy-rs\ntempoxyz"), ["tempoxyz", "paradigmxyz/reth", "alloy-rs"]);
});

test("workflow analysis detects high-impact SITF patterns", () => {
  const text = `
on:
  pull_request_target:
permissions: write-all
jobs:
  test:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@main
      - run: echo "\${{ github.event.pull_request.title }}"
      - run: echo "\${{ toJson(secrets) }}"
`;
  const findings = analyzeWorkflow(repo, { path: ".github/workflows/test.yml" }, text);
  assert.deepEqual(new Set(findings.map((item) => item.check_id)), new Set([
    "mutable_action_ref",
    "privileged_pr_trigger",
    "script_injection",
    "self_hosted_runner",
    "broad_write_permissions",
    "secret_enumeration",
  ]));
});

test("workflow analysis accepts immutable action pins", () => {
  const sha = "a".repeat(40);
  const findings = analyzeWorkflow(repo, { path: ".github/workflows/test.yml" }, `steps:\n  - uses: actions/checkout@${sha}\n`);
  assert.equal(findings.some((item) => item.check_id === "mutable_action_ref"), false);
});

test("workflow analysis distinguishes a pwn request from metadata-only pull_request_target", () => {
  const sha = "a".repeat(40);
  const text = `on:\n  pull_request_target:\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@${sha}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
  const findings = analyzeWorkflow(repo, { path: ".github/workflows/test.yml" }, text);
  assert.equal(findings.some((item) => item.check_id === "pwn_request"), true);
});

test("tree analysis finds unlocked manifests and missing updater configuration", () => {
  const tree = [{ path: "package.json" }, { path: "crates/tool/Cargo.toml" }, { path: "crates/tool/Cargo.lock" }];
  const findings = analyzeTree(repo, tree);
  assert.deepEqual(new Set(findings.map((item) => item.check_id)), new Set(["unlocked_dependencies", "dependency_updates_missing"]));
  assert.deepEqual(findings.find((item) => item.check_id === "unlocked_dependencies").evidence, ["package.json"]);
});

test("mapLimit preserves input ordering", async () => {
  const values = await mapLimit([3, 1, 2], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value));
    return value * 2;
  });
  assert.deepEqual(values, [6, 2, 4]);
});
