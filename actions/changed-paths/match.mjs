// Path filters in the dorny/paths-filter style: a filter is a list of glob patterns; a path
// matches when it matches at least one positive pattern and no negated (`!`) pattern.
// Globs: `**` (any depth), `*` (within a segment), `?`, `{a,b}` alternation. Patterns are
// anchored at the repository root.
export function globToRegExp(glob) {
  let g = glob.trim();
  const dirOnly = g.endsWith("/");
  if (dirOnly) g = g.slice(0, -1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) { re += "\\{"; continue; }
      re += "(?:" + g.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${dirOnly ? "(?:/.*)?" : ""}$`);
}

export function compileFilter(patterns) {
  const pos = [], neg = [];
  for (const p of patterns) {
    const s = String(p).trim();
    if (!s) continue;
    if (s.startsWith("!")) neg.push(globToRegExp(s.slice(1))); else pos.push(globToRegExp(s));
  }
  return (path) => pos.some((r) => r.test(path)) && !neg.some((r) => r.test(path));
}

// filters: { name: [patterns] }, files: [paths] -> { name: { matched: [paths] } }
export function applyFilters(filters, files) {
  const out = {};
  for (const [name, patterns] of Object.entries(filters)) {
    const m = compileFilter(Array.isArray(patterns) ? patterns : [patterns]);
    out[name] = { matched: files.filter((f) => m(f)) };
  }
  return out;
}
