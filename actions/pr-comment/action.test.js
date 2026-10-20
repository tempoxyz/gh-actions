const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const MARKER = "<!-- pr-comment: coverage -->";

// The composite step's script, as GitHub Actions runs it.
function actionScript() {
  const lines = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line === "      run: |") + 1;
  return lines.slice(start).filter((line) => line === "" || line.startsWith("        ")).map((line) => line.slice(8)).join("\n");
}

// Stub gh: logs every call, answers the comment listing by running the action's
// own --jq filter over the scenario's comments, and records the bodies it is sent.
const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
for arg in "$@"; do [[ "$arg" == body=@* ]] && cp "\${arg#body=@}" "$GH_LOG.body"; done
case "$*" in
  "api repos/o/r/issues/7/comments --paginate --jq "*)
    [[ -n "$STUB_LIST_FAILS" ]] && { echo "HTTP 502" >&2; exit 1; }
    jq -r "$5" "$STUB_COMMENTS" ;;
  "api repos/o/r/issues/comments/41 --jq .body") cat "$STUB_PREVIOUS_BODY" ;;
  "api -X POST "*) echo 99 ;;
  "api -X PATCH "*) echo 41 ;;
esac
`;

function run(t, { comments = [], mode = "replace", listFails = false, previousBody = "" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-comment-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), GH_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "comments.json"), JSON.stringify(comments));
  fs.writeFileSync(path.join(directory, "previous.md"), previousBody);

  const log = path.join(directory, "gh.log");
  const result = spawnSync("bash", ["-c", actionScript()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_LOG: log,
      NUMBER: "7",
      HEADER: "coverage",
      MESSAGE: "Coverage: 91%",
      BODY_PATH: "",
      MODE: mode,
      REPO: "o/r",
      GITHUB_OUTPUT: path.join(directory, "output"),
      RUNNER_TEMP: directory,
      STUB_COMMENTS: path.join(directory, "comments.json"),
      STUB_PREVIOUS_BODY: path.join(directory, "previous.md"),
      STUB_LIST_FAILS: listFails ? "1" : "",
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  const body = fs.existsSync(`${log}.body`) ? fs.readFileSync(`${log}.body`, "utf8") : null;
  const output = fs.existsSync(path.join(directory, "output")) ? fs.readFileSync(path.join(directory, "output"), "utf8") : "";
  return { ...result, calls, body, output };
}

const writes = (calls) => calls.filter((call) => call.startsWith("api -X ")).map((call) => call.split(" ").slice(0, 4).join(" "));

test("updates the newest comment that carries the marker", (t) => {
  const result = run(t, {
    comments: [
      { id: 10, body: `old\n\n${MARKER}\n` },
      { id: 11, body: "an unrelated comment" },
      { id: 41, body: `newer\n\n${MARKER}\n` },
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes(result.calls), ["api -X PATCH repos/o/r/issues/comments/41"]);
  assert.equal(result.body, `Coverage: 91%\n\n${MARKER}\n`);
  assert.match(result.output, /^comment-id=41$/m);
});

test("creates a comment when none carries the marker", (t) => {
  const result = run(t, { comments: [{ id: 11, body: "<!-- pr-comment: other -->" }] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes(result.calls), ["api -X POST repos/o/r/issues/7/comments"]);
  assert.match(result.output, /^comment-id=99$/m);
});

test("a failed lookup fails the step instead of posting a duplicate", (t) => {
  const result = run(t, { comments: [{ id: 41, body: MARKER }], listFails: true });

  assert.notEqual(result.status, 0);
  assert.deepEqual(writes(result.calls), []);
});

test("delete removes the marked comment", (t) => {
  const result = run(t, { comments: [{ id: 41, body: MARKER }], mode: "delete" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(writes(result.calls), ["api -X DELETE repos/o/r/issues/comments/41"]);
});

test("append adds to the marked comment", (t) => {
  const previous = `First run\n\n${MARKER}\n`;
  const result = run(t, { comments: [{ id: 41, body: previous }], mode: "append", previousBody: previous });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body, `${previous}\n\nCoverage: 91%`);
});
