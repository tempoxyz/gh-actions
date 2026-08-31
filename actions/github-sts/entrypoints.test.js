const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  revocationRequestOptions,
  revokeToken,
  stsRevocationRequestOptions,
} = require("./post.js");

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

test("STS revocation request authenticates with the minted token", () => {
  const options = stsRevocationRequestOptions("test-token");

  assert.equal(options.method, "DELETE");
  assert.equal(options.headers.Authorization, "Bearer test-token");
  assert.equal(options.headers["User-Agent"], "tempoxyz-gh-actions-github-sts");
});

test("workflow cleanup revokes through STS without calling GitHub directly", async () => {
  const calls = [];
  const messages = [];
  await revokeToken("test-token", "gh-sts.tehq.dev", {
    request: async (url, options) => {
      calls.push({ url, options });
      return 204;
    },
    retry: async (operation) => operation(),
    console: { log: (message) => messages.push(message), warn: (message) => messages.push(message) },
  });

  assert.deepEqual(calls.map((call) => call.url), ["https://gh-sts.tehq.dev/sts/exchange"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(messages, ["GitHub App token revoked and STS ledger updated."]);
});

test("workflow cleanup falls back to GitHub and then reconciles the STS ledger", async () => {
  const calls = [];
  const statuses = [404, 204, 204];
  await revokeToken("test-token", "gh-sts.tehq.net", {
    request: async (url) => {
      calls.push(url);
      return statuses.shift();
    },
    retry: async (operation) => operation(),
    console: { log() {}, warn() {} },
  });

  assert.deepEqual(calls, [
    "https://gh-sts.tehq.net/sts/exchange",
    "https://api.github.com/installation/token",
    "https://gh-sts.tehq.net/sts/exchange",
  ]);
});

test("workflow cleanup never sends a token to an unknown STS host", async () => {
  const calls = [];
  await revokeToken("test-token", "attacker.example", {
    request: async (url) => {
      calls.push(url);
      return 204;
    },
    retry: async (operation) => operation(),
    console: { log() {}, warn() {} },
  });

  assert.deepEqual(calls, ["https://api.github.com/installation/token"]);
});
