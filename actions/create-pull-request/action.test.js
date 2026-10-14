const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const NEW_SHA = "c".repeat(40);
const BRANCH_SHA = "b".repeat(40);

// The composite step's script, as GitHub Actions runs it.
function actionScript() {
  const lines = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line === "      run: |") + 1;
  return lines.slice(start).filter((line) => line === "" || line.startsWith("        ")).map((line) => line.slice(8)).join("\n");
}

const bashSupportsMapfile = spawnSync("bash", ["-c", "mapfile -t x < /dev/null"]).status === 0;

// Stub gh: logs every call and answers the few queries the script makes
// from the scenario's environment.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "api repos/o/r/git/ref/heads/bot/sync --jq .object.sha") [[ -n "$STUB_BRANCH_SHA" ]] && echo "$STUB_BRANCH_SHA" || exit 1 ;;
  "api repos/o/r/git/ref/heads/"*) exit 1 ;;
  "pr list"*) echo "$STUB_PR" ;;
  "api repos/o/r/git/commits/"*" --jq .tree.sha") echo "$STUB_BRANCH_TREE" ;;
  "api graphql"*) cp "\${4}" "$GH_LOG.graphql"; echo "${NEW_SHA}" ;;
  "pr create"*) echo "https://github.com/o/r/pull/7" ;;
esac
`;

function run(t, { branchSha = "", pr = "", sameTree = false, autoMerge = "" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "create-pr-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  fs.writeFileSync(path.join(repo, "skill.md"), "new\n");
  const tree = sameTree ? (git("add", "-A"), git("write-tree").stdout.trim()) : "other-tree";
  git("reset", "-q");

  const log = path.join(directory, "gh.log");
  const result = spawnSync("bash", ["-c", actionScript()], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: log,
      GH_REPO: "o/r",
      BRANCH: "bot/sync",
      BASE: "main",
      COMMIT_MESSAGE: "chore: sync",
      TITLE: "chore: sync",
      BODY: "body",
      ADD_PATHS: ".",
      LABELS: "",
      AUTO_MERGE: autoMerge,
      GITHUB_RUN_ID: "11",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_OUTPUT: path.join(directory, "output"),
      RUNNER_TEMP: directory,
      STUB_BRANCH_SHA: branchSha,
      STUB_PR: pr,
      STUB_BRANCH_TREE: tree,
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const graphql = fs.existsSync(`${log}.graphql`) ? JSON.parse(fs.readFileSync(`${log}.graphql`, "utf8")) : null;
  const output = fs.existsSync(path.join(directory, "output")) ? fs.readFileSync(path.join(directory, "output"), "utf8") : "";
  return { ...result, calls, graphql, output };
}

test("create-pull-request scenarios", { skip: !bashSupportsMapfile && "needs bash 4+" }, async (t) => {
  await t.test("opens a PR from a new branch", (t) => {
    const result = run(t);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.graphql.variables.input.branch.branchName, "bot/sync");
    assert.ok(result.calls.some((call) => call.startsWith("api repos/o/r/git/refs -f ref=refs/heads/bot/sync")));
    assert.ok(result.calls.some((call) => call.startsWith("pr create")));
    assert.ok(!result.calls.some((call) => call.startsWith("pr merge")));
    assert.match(result.output, new RegExp(`pull-request-number=7\nhead-sha=${NEW_SHA}`));
  });

  await t.test("moves an open PR's branch in one update without resetting it", (t) => {
    const result = run(t, { branchSha: BRANCH_SHA, pr: "5" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.graphql.variables.input.branch.branchName, "bot/sync-update-11-2");
    const updates = result.calls.filter((call) => call.startsWith("api -X PATCH repos/o/r/git/refs/heads/bot/sync "));
    assert.deepEqual(updates, [`api -X PATCH repos/o/r/git/refs/heads/bot/sync -f sha=${NEW_SHA} -F force=true`]);
    assert.ok(result.calls.includes("api -X DELETE repos/o/r/git/refs/heads/bot/sync-update-11-2"));
    assert.ok(result.calls.some((call) => call.startsWith("pr edit 5")));
  });

  await t.test("leaves an open PR that already has the changes", (t) => {
    const result = run(t, { branchSha: BRANCH_SHA, pr: "5", sameTree: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.graphql, null);
    assert.ok(!result.calls.some((call) => call.includes("-X PATCH")));
    assert.match(result.output, new RegExp(`head-sha=${BRANCH_SHA}`));
  });

  await t.test("enables auto-merge", (t) => {
    const result = run(t, { autoMerge: "squash" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.calls.includes("pr merge --repo o/r 7 --auto --squash"));
  });

  await t.test("rejects an unknown auto-merge method", (t) => {
    const result = run(t, { autoMerge: "fast-forward" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /auto-merge must be merge, squash, rebase, or empty/);
    assert.deepEqual(result.calls, []);
  });
});
