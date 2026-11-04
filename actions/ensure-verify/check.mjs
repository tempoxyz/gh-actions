// Pure decisions for ensure-verify; main.mjs does the GitHub API calls.

// run: the newest workflow run for the commit, or undefined while none exists yet.
// Returns wait (not started or not finished), pass, or fail with the run's conclusion.
export function evaluateRun(run) {
  if (!run || run.status !== "completed") return { state: "wait" };
  if (run.conclusion === "success") return { state: "pass" };
  return { state: "fail", conclusion: run.conclusion ?? "unknown" };
}

// Whether the tip comparison applies: rerun compares only when run_attempt is above 1, so a
// first attempt (which concurrency keeps in push order) always ships.
export function needsTipCheck(mode, attempt) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (mode === "rerun") return Number(attempt) > 1;
  throw new Error(`check-tip must be rerun, always or never, not ${JSON.stringify(mode)}`);
}

// A commit ships only while it is still the branch tip, so a re-run of an older run
// never deploys or publishes over newer commits.
export function shouldShip({ sha, tip }) {
  if (!tip) throw new Error("branch tip is unknown");
  return tip === sha;
}

// Transient API failures (network errors, 429 and 5xx) are retried; anything else is final.
export function isTransient(status) {
  return status === undefined || status === 429 || status >= 500;
}
