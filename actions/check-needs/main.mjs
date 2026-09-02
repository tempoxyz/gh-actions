import { evaluate, parseList } from "./check.mjs";

let jobs;
try { jobs = JSON.parse(process.env.JOBS ?? ""); }
catch { console.error("::error::check-needs: `jobs` must be `${{ toJSON(needs) }}`"); process.exit(1); }
if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0) {
  console.error("::error::check-needs: `jobs` is empty; did the job declare `needs:`?");
  process.exit(1);
}
const { ok, rows, problems } = evaluate(jobs, {
  allowedSkips: parseList(process.env.ALLOWED_SKIPS),
  allowedFailures: parseList(process.env.ALLOWED_FAILURES),
});
for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}: ${r.result}`);
if (!ok) { console.error(`::error::check-needs: ${problems.join("; ")}`); process.exit(1); }
console.log("all needed jobs succeeded (or were allowed to skip/fail)");
