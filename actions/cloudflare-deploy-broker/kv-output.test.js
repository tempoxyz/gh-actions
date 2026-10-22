const assert = require("node:assert/strict");
const test = require("node:test");
const { databaseIds, namespaceIds } = require("./kv-output.cjs");

test("exports exact KV IDs as a single-line JSON map and supports old broker responses", () => {
  assert.equal(namespaceIds(undefined), "{}");
  assert.equal(
    namespaceIds([{ binding: "CACHE", namespaceId: "a".repeat(32) }]),
    JSON.stringify({ CACHE: "a".repeat(32) }),
  );
});

test("rejects invalid or duplicate KV output receipts", () => {
  for (const value of [
    null,
    {},
    [{ binding: "BAD\nOUTPUT", namespaceId: "a".repeat(32) }],
    [{ binding: "CACHE", namespaceId: "invalid" }],
    [
      { binding: "CACHE", namespaceId: "a".repeat(32) },
      { binding: "CACHE", namespaceId: "b".repeat(32) },
    ],
    [
      { binding: "CACHE", namespaceId: "a".repeat(32) },
      { binding: "OTHER", namespaceId: "a".repeat(32) },
    ],
  ])
    assert.throws(() => namespaceIds(value));
});

test("exports exact D1 IDs as a single-line JSON map and rejects invalid receipts", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(databaseIds(undefined), "{}");
  assert.equal(
    databaseIds([{ binding: "DB", databaseId: id }]),
    JSON.stringify({ DB: id }),
  );
  for (const invalid of [
    null,
    [{ binding: "DB", databaseId: "a".repeat(32) }],
    [
      { binding: "DB", databaseId: id },
      { binding: "OTHER", databaseId: id },
    ],
  ])
    assert.throws(() => databaseIds(invalid));
});
