const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { revocationRequestOptions } = require("./post.js");

const actionDirectory = __dirname;

test("main entrypoint executes as CommonJS", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY_OWNER: "tempoxyz",
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

test("main rejects repositories outside tempoxyz before resolving STS inputs", () => {
  const result = spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY_OWNER: "outside-contributor",
      INPUT_DEV: "invalid",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /only supports repositories owned by tempoxyz/);
  assert.doesNotMatch(output, /dev must|id-token/);
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

test("revocation request identifies the action to GitHub", () => {
  const options = revocationRequestOptions("test-token");

  assert.equal(options.headers["User-Agent"], "tempoxyz-gh-actions-github-sts");
});
