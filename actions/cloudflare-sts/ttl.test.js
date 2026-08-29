const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_TTL_MS, parseTtl } = require("./ttl.js");

test("accepts friendly TTL values up to one hour", () => {
  assert.equal(parseTtl("45s"), 45 * 1000);
  assert.equal(parseTtl("5m"), 5 * 60 * 1000);
  assert.equal(parseTtl("1h"), MAX_TTL_MS);
  assert.equal(parseTtl("60m"), MAX_TTL_MS);
  assert.equal(parseTtl("3600s"), MAX_TTL_MS);
});

test("rejects malformed, zero, and over-one-hour TTL values", () => {
  for (const value of ["", "0s", "1", "1d", "1.5m", "1m30s", "60M", "61m", "3601s"]) {
    assert.throws(() => parseTtl(value), /ttl/);
  }
});
