const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { host } = require("./http.cjs");
const { publishToken } = require("./main.cjs");

test("selects the fixed development and production endpoints", () => {
  assert.equal(host("true"), "socket-sts.tehq.dev");
  assert.equal(host("false"), "socket-sts.tehq.net");
  assert.throws(() => host("yes"), /dev must be either true or false/);
});

test("main fails closed without GitHub id-token permission", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_DEV: "false",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing/,
  );
});

test("masks the token before publishing it as output or state", () => {
  const calls = [];
  const originalAppendFileSync = fs.appendFileSync;
  const originalLog = console.log;
  const originalOutput = process.env.GITHUB_OUTPUT;
  const originalState = process.env.GITHUB_STATE;
  fs.appendFileSync = (file, value) => calls.push(["append", file, value]);
  console.log = (value) => calls.push(["log", value]);
  process.env.GITHUB_OUTPUT = "github-output";
  process.env.GITHUB_STATE = "github-state";

  try {
    publishToken("socket%token-with-sensitive-value", "2026-08-29T03:00:00Z");
  } finally {
    fs.appendFileSync = originalAppendFileSync;
    console.log = originalLog;
    if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = originalOutput;
    if (originalState === undefined) delete process.env.GITHUB_STATE;
    else process.env.GITHUB_STATE = originalState;
  }

  assert.deepEqual(calls, [
    ["log", "::add-mask::socket%25token-with-sensitive-value"],
    [
      "append",
      "github-output",
      "token=socket%token-with-sensitive-value\n",
    ],
    ["append", "github-output", "expires-at=2026-08-29T03:00:00Z\n"],
    [
      "append",
      "github-state",
      "token=socket%token-with-sensitive-value\n",
    ],
  ]);
});

test("post is a no-op when no token was minted", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /skipping revocation/);
});
