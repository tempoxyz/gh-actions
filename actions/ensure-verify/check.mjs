// Pure decisions for ensure-verify; main.mjs does the GitHub API calls.

// run: the newest workflow run for the commit, or undefined while none exists yet.
// Returns wait (not started or not finished), missing (no run after the grace period),
// pass, or fail with the run's conclusion.
export function evaluateRun(run, { pastGrace = false } = {}) {
  if (!run) return { state: pastGrace ? "missing" : "wait" };
  if (run.status !== "completed") return { state: "wait" };
  if (run.conclusion === "success") return { state: "pass" };
  return { state: "fail", conclusion: run.conclusion ?? "unknown" };
}

// Whether the tip comparison applies: rerun compares only when run_attempt is above 1, so a
// first attempt (which concurrency keeps in push order) always ships.
export function needsTipCheck(mode, attempt) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  if (mode === "rerun") return Number(attempt) > 1;
  throw new Error("check-tip must be rerun, always or never, not " + JSON.stringify(mode));
}

// A commit ships only while it is still the branch tip, so a re-run of an older run
// never deploys or publishes over newer commits.
export function shouldShip({ sha, tip }) {
  if (!tip) throw new Error("branch tip is unknown");
  return tip === sha;
}

// Seconds to wait before retrying a failed request, or null when it is final. Network
// errors, 429 and 5xx are transient, and so is a 403 that is a rate limit (GitHub answers
// primary and secondary rate limits with 403 or 429); any other 403 is a real permission error.
// headers: a Headers-like object with get(); now: Unix seconds.
export function retryDelay({ status, headers, body = "", attempt, now = Date.now() / 1000 }) {
  const header = (name) => headers?.get?.(name) ?? null;
  const limited = status === 429 || (status === 403 && (
    header("retry-after") !== null || header("x-ratelimit-remaining") === "0" || /rate limit/i.test(body)));
  if (!(status === undefined || status >= 500 || limited)) return null;
  const retryAfter = Number(header("retry-after"));
  if (retryAfter > 0) return Math.min(retryAfter, 300);
  const reset = Number(header("x-ratelimit-reset"));
  if (limited && reset > now) return Math.min(Math.ceil(reset - now) + 1, 300);
  return 2 ** attempt;
}
