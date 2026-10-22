const bindingPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
function receiptIds(value, key, pattern, label) {
  if (value === undefined) return "{}";
  if (!Array.isArray(value) || value.length > 10)
    throw new Error(`Invalid broker ${label} receipt`);
  const entries = value.map((binding) => {
    if (
      !binding ||
      typeof binding.binding !== "string" ||
      !bindingPattern.test(binding.binding) ||
      typeof binding[key] !== "string" ||
      !pattern.test(binding[key])
    )
      throw new Error(`Invalid broker ${label} receipt`);
    return [binding.binding, binding[key]];
  });
  if (
    new Set(entries.map(([binding]) => binding)).size !== entries.length ||
    new Set(entries.map(([, id]) => id)).size !== entries.length
  )
    throw new Error(`Duplicate broker ${label} receipt`);
  return JSON.stringify(Object.fromEntries(entries));
}
function namespaceIds(value) {
  return receiptIds(value, "namespaceId", /^[0-9a-f]{32}$/, "KV");
}
function databaseIds(value) {
  return receiptIds(
    value,
    "databaseId",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "D1",
  );
}
module.exports = { namespaceIds, databaseIds };
