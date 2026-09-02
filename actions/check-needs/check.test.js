import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, parseList } from "./check.mjs";

test("all success passes", () => {
  assert.equal(evaluate({ a: { result: "success" }, b: { result: "success" } }).ok, true);
});
test("failure and cancelled fail", () => {
  assert.equal(evaluate({ a: { result: "failure" } }).ok, false);
  assert.equal(evaluate({ a: { result: "cancelled" } }).ok, false);
});
test("skipped fails unless allowed", () => {
  assert.equal(evaluate({ a: { result: "skipped" } }).ok, false);
  assert.equal(evaluate({ a: { result: "skipped" } }, { allowedSkips: ["a"] }).ok, true);
});
test("allowed failures", () => {
  const r = evaluate({ a: { result: "failure" }, b: { result: "success" } }, { allowedFailures: ["a"] });
  assert.equal(r.ok, true);
});
test("problems name the offending jobs", () => {
  assert.deepEqual(evaluate({ a: { result: "failure" }, b: { result: "skipped" } }).problems, ["a: failure", "b: skipped"]);
});
test("parseList accepts commas, spaces and newlines", () => {
  assert.deepEqual(parseList("a, b\nc  d"), ["a", "b", "c", "d"]);
  assert.deepEqual(parseList(""), []);
});
