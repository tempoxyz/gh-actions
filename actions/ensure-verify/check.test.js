import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, needsTipCheck, retryDelay, shouldShip } from "./check.mjs";

const headers = (h) => ({ get: (name) => h[name] ?? null });

test("waits for a missing run until the grace period, then reports it missing", () => {
  assert.deepEqual(evaluateRun(undefined), { state: "wait" });
  assert.deepEqual(evaluateRun(undefined, { pastGrace: true }), { state: "missing" });
});
test("waits while the run has not finished, however long", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    assert.deepEqual(evaluateRun({ status }, { pastGrace: true }), { state: "wait" });
  }
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
test("retries network errors, 429 and 5xx with backoff", () => {
  for (const status of [undefined, 429, 500, 502, 503]) assert.equal(retryDelay({ status, attempt: 2 }), 4, String(status));
});
test("retries rate-limit 403s and waits for their reset", () => {
  assert.equal(retryDelay({ status: 403, headers: headers({ "retry-after": "60" }), attempt: 1 }), 60);
  assert.equal(retryDelay({ status: 403, headers: headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1100" }), attempt: 1, now: 1000 }), 101);
  assert.equal(retryDelay({ status: 403, body: "You have exceeded a secondary rate limit", attempt: 3 }), 8);
  assert.equal(retryDelay({ status: 429, headers: headers({ "retry-after": "9999" }), attempt: 1 }), 300);
});
test("fails at once on permission and other client errors", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(retryDelay({ status, headers: headers({}), body: "Resource not accessible by integration", attempt: 1 }), null, String(status));
  }
});
