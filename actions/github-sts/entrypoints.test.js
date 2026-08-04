const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const actionDirectory = __dirname;

test("main entrypoint executes as CommonJS", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_DEV: "false",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /id-token: write permission is required/);
  assert.doesNotMatch(output, /ERR_AMBIGUOUS_MODULE_SYNTAX/);
});

test("post entrypoint executes as CommonJS without a token", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "post.js")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No GitHub App token was minted; skipping revocation/);
  assert.doesNotMatch(output, /ERR_AMBIGUOUS_MODULE_SYNTAX/);
});
