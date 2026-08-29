const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const actionDirectory = __dirname;

function run(inputs = {}) {
  return spawnSync(process.execPath, [path.join(actionDirectory, "main.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_DEV: "false",
      INPUT_POLICY: "e2e",
      INPUT_TTL: "15m",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      ACTIONS_ID_TOKEN_REQUEST_URL: "",
      ...inputs,
    },
  });
}

test("main entrypoint executes as CommonJS", () => {
  const result = run();
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /id-token: write permission is required/);
  assert.doesNotMatch(output, /ERR_AMBIGUOUS_MODULE_SYNTAX/);
});

test("main entrypoint rejects a TTL longer than one hour before requesting OIDC", () => {
  const result = run({ INPUT_TTL: "61m" });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /ttl must not exceed 1h/);
  assert.doesNotMatch(output, /id-token: write permission is required/);
});
