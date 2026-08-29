const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { host } = require("./http.cjs");

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

test("post is a no-op when no token was minted", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /skipping revocation/);
});
