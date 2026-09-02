// Decide whether a set of `needs` results counts as success.
// jobs: the object from `toJSON(needs)`; each value has a `result` of
// success | failure | cancelled | skipped.
export function evaluate(jobs, { allowedSkips = [], allowedFailures = [] } = {}) {
  const problems = [];
  const rows = [];
  for (const [name, job] of Object.entries(jobs ?? {})) {
    const result = job?.result ?? "unknown";
    let ok = result === "success";
    if (result === "skipped" && allowedSkips.includes(name)) ok = true;
    if (result === "failure" && allowedFailures.includes(name)) ok = true;
    rows.push({ name, result, ok });
    if (!ok) problems.push(`${name}: ${result}`);
  }
  return { ok: problems.length === 0, rows, problems };
}

export function parseList(value) {
  return String(value ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
