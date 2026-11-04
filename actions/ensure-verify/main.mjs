import { appendFileSync } from "node:fs";
import { evaluateRun, needsTipCheck, isTransient, shouldShip } from "./check.mjs";

const env = process.env;
const fail = (message) => { console.error(`::error::ensure-verify: ${message}`); process.exit(1); };
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const output = (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);

for (const name of ["WORKFLOW", "SHA", "REPO", "TOKEN"]) if (!env[name]) fail(`${name.toLowerCase()} is empty`);
const timeout = Number(env.TIMEOUT_MINUTES) * 60;
const poll = Number(env.POLL_SECONDS);
if (!(timeout > 0) || !(poll > 0)) fail("timeout-minutes and poll-seconds must be positive numbers");
let tipCheck;
try { tipCheck = needsTipCheck(env.CHECK_TIP || "rerun", env.RUN_ATTEMPT); } catch (e) { fail(e.message); }

// GET with retries for transient failures; a final error fails the step rather than skipping.
async function get(path) {
  for (let attempt = 1; ; attempt++) {
    let status;
    try {
      const res = await fetch(`${env.API_URL || "https://api.github.com"}${path}`, {
        headers: { authorization: `Bearer ${env.TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      });
      status = res.status;
      if (res.ok) return await res.json();
      if (!isTransient(status) || attempt >= 5) fail(`GET ${path}: ${status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      if (attempt >= 5) fail(`GET ${path}: ${e.message}`);
    }
    console.log(`GET ${path} failed (${status ?? "network error"}), retrying`);
    await sleep(2 ** attempt);
  }
}

const event = env.EVENT || "push";
const workflow = encodeURIComponent(env.WORKFLOW);
const query = new URLSearchParams({ head_sha: env.SHA, event, per_page: "1" });
const deadline = Date.now() + timeout * 1000;
let run;
for (;;) {
  run = (await get(`/repos/${env.REPO}/actions/workflows/${workflow}/runs?${query}`)).workflow_runs?.[0];
  const result = evaluateRun(run);
  if (result.state === "pass") break;
  if (result.state === "fail") fail(`${env.WORKFLOW} ${result.conclusion} on ${env.SHA}: ${run.html_url}`);
  if (Date.now() > deadline) fail(`timed out after ${env.TIMEOUT_MINUTES} minutes waiting for ${env.WORKFLOW} on ${env.SHA}${run ? `: ${run.html_url}` : " (no run found)"}`);
  console.log(run ? `${env.WORKFLOW} is ${run.status}: ${run.html_url}` : `no ${env.WORKFLOW} ${event} run for ${env.SHA} yet`);
  await sleep(poll);
}
console.log(`${env.WORKFLOW} passed: ${run.html_url}`);
output("run-url", run.html_url);

let ship = true;
if (tipCheck) {
  const branch = env.BRANCH || (await get(`/repos/${env.REPO}`)).default_branch;
  const tip = (await get(`/repos/${env.REPO}/commits/${encodeURIComponent(branch)}`)).sha;
  try { ship = shouldShip({ sha: env.SHA, tip }); } catch (e) { fail(e.message); }
  if (!ship) console.log(`::notice::ensure-verify: ${branch} has moved past ${env.SHA} (tip ${tip}); not shipping this re-run`);
}
output("ship", String(ship));
