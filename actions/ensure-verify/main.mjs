import { appendFileSync } from "node:fs";
import { evaluateRun, needsTipCheck, retryDelay, shouldShip } from "./check.mjs";

const env = process.env;
const fail = (message) => { console.error("::error::ensure-verify: " + message); process.exit(1); };
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const output = (name, value) => appendFileSync(env.GITHUB_OUTPUT, name + "=" + value + "\n");

for (const name of ["WORKFLOW", "SHA", "REPO", "TOKEN"]) if (!env[name]) fail(name.toLowerCase() + " is empty");
const timeout = Number(env.TIMEOUT_MINUTES) * 60;
const grace = Number(env.MISSING_MINUTES) * 60;
const poll = Number(env.POLL_SECONDS);
if (!(timeout > 0) || !(grace > 0) || !(poll > 0)) fail("timeout-minutes, missing-minutes and poll-seconds must be positive numbers");
let tipCheck;
try { tipCheck = needsTipCheck(env.CHECK_TIP || "rerun", env.RUN_ATTEMPT); } catch (e) { fail(e.message); }

// GET with retries for transient failures and rate limits; a final error fails the step rather
// than skipping it.
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    let status, headers, body = "";
    try {
      const res = await fetch((env.API_URL || "https://api.github.com") + path, {
        headers: { authorization: "Bearer " + env.TOKEN, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      });
      if (res.ok) return await res.json();
      ({ status, headers } = res);
      body = await res.text();
    } catch (e) {
      body = e.message;
    }
    const delay = retryDelay({ status, headers, body, attempt });
    if (delay === null || attempt >= 6) fail("GET " + path + ": " + (status ?? "network error") + " " + body.slice(0, 200));
    console.log("GET " + path + " failed (" + (status ?? "network error") + "), retrying in " + delay + "s");
    await sleep(delay);
  }
}

const event = env.EVENT || "push";
const branch = env.BRANCH || env.REF_NAME || (await get("/repos/" + env.REPO)).default_branch;
const workflow = encodeURIComponent(env.WORKFLOW);
const query = new URLSearchParams({ head_sha: env.SHA, event, branch, per_page: "1" });
const start = Date.now();
const name = env.WORKFLOW + " " + event + " run on " + branch + " for " + env.SHA;
let run;
for (;;) {
  run = (await get("/repos/" + env.REPO + "/actions/workflows/" + workflow + "/runs?" + query)).workflow_runs?.[0];
  const result = evaluateRun(run, { pastGrace: Date.now() - start > grace * 1000 });
  if (result.state === "pass") break;
  if (result.state === "fail") fail(env.WORKFLOW + " " + result.conclusion + " on " + env.SHA + ": " + run.html_url);
  if (result.state === "missing") fail("no " + name + " after " + env.MISSING_MINUTES + " minutes; do its triggers (branches, paths) cover every push this workflow ships?");
  if (Date.now() - start > timeout * 1000) fail("timed out after " + env.TIMEOUT_MINUTES + " minutes waiting for " + env.WORKFLOW + " on " + env.SHA + ": " + run.html_url);
  console.log(run ? env.WORKFLOW + " is " + run.status + ": " + run.html_url : "no " + name + " yet");
  await sleep(poll);
}
console.log(env.WORKFLOW + " passed: " + run.html_url);
output("run-url", run.html_url);

let ship = true;
if (tipCheck) {
  const tip = (await get("/repos/" + env.REPO + "/commits/" + encodeURIComponent(branch))).sha;
  try { ship = shouldShip({ sha: env.SHA, tip }); } catch (e) { fail(e.message); }
  if (!ship) console.log("::notice::ensure-verify: " + branch + " has moved past " + env.SHA + " (tip " + tip + "); not shipping this re-run");
}
output("ship", String(ship));
