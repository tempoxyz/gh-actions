import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, needsTipCheck, isTransient, shouldShip } from "./check.mjs";

test("waits while no run exists or it has not finished", () => {
  assert.deepEqual(evaluateRun(undefined), { state: "wait" });
  for (const status of ["queued", "in_progress", "waiting", "pending"]) assert.deepEqual(evaluateRun({ status }), { state: "wait" });
});
test("passes only on success", () => {
  assert.deepEqual(evaluateRun({ status: "completed", conclusion: "success" }), { state: "pass" });
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "action_required", "neutral"]) {
    assert.deepEqual(evaluateRun({ status: "completed", conclusion }), { state: "fail", conclusion });
  }
  assert.deepEqual(evaluateRun({ status: "completed" }), { state: "fail", conclusion: "unknown" });
});
test("rerun mode checks the tip only on re-runs", () => {
  assert.equal(needsTipCheck("rerun", "1"), false);
  assert.equal(needsTipCheck("rerun", "2"), true);
  assert.equal(needsTipCheck("always", "1"), true);
  assert.equal(needsTipCheck("never", "3"), false);
  assert.throws(() => needsTipCheck("sometimes", "1"));
});
test("ships only at the tip and refuses an unknown tip", () => {
  assert.equal(shouldShip({ sha: "a", tip: "a" }), true);
  assert.equal(shouldShip({ sha: "a", tip: "b" }), false);
  assert.throws(() => shouldShip({ sha: "a", tip: "" }));
  assert.throws(() => shouldShip({ sha: "a", tip: undefined }));
});
test("retries network errors, rate limits and server errors only", () => {
  for (const status of [undefined, 429, 500, 502, 503]) assert.equal(isTransient(status), true, String(status));
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isTransient(status), false, String(status));
});
