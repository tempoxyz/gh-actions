const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { host, rateLimitDelay, retry, retryRateLimited } = require("./http.cjs");
const { publishToken } = require("./main.cjs");
const { buildRevokeRequest } = require("./post.cjs");
const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("selects the fixed development and production endpoints", () => {
  assert.equal(host("true"), "socket-sts.tehq.dev");
  assert.equal(host("false"), "socket-sts.tehq.net");
  assert.throws(() => host("yes"), /dev must be either true or false/);
});

test("does not retry an exchange after receiving an HTTP response", async () => {
  let attempts = 0;
  const response = await retry(
    async () => {
      attempts += 1;
      return { status: 502, body: "upstream failure" };
    },
    { retryHttpResponses: false },
  );

  assert.equal(attempts, 1);
  assert.equal(response.status, 502);
});

test("honors Socket STS rate-limit metadata before retrying", async () => {
  let attempts = 0;
  const delays = [];
  const response = await retryRateLimited(
    async () => {
      attempts += 1;
      return attempts === 1
        ? { status: 429, headers: { "retry-after": "2" }, body: "" }
        : { status: 200, headers: {}, body: "recovered" };
    },
    { now: () => 0, sleep: async (delay) => delays.push(delay) },
  );

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2_000]);
  assert.equal(
    rateLimitDelay({ status: 429, headers: {}, body: '{"retry_after_ms":250}' }, 0),
    250,
  );
});

test("fails instead of waiting more than two minutes for a Socket STS rate limit", async () => {
  await assert.rejects(
    retryRateLimited(
      async () => ({
        status: 429,
        headers: { "retry-after": "121" },
        body: "",
      }),
      { now: () => 0, sleep: async () => {} },
    ),
    /exceeds the 2 minute limit/,
  );
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
    ["append", "github-output", `node-path=${process.execPath}\n`],
  ]);
});

test("revokes tokens by deleting the exchange resource", () => {
  const token = "sktsec_test_short_lived_token_api";
  const revoke = buildRevokeRequest(token, "true");

  assert.equal(revoke.url, "https://socket-sts.tehq.dev/sts/exchange");
  assert.equal(revoke.options.method, "DELETE");
  assert.equal(revoke.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(revoke.body), { token });
});

test("can register a post-job Aegis audit-log upload", async () => {
  assert.match(
    manifest,
    /upload-aegis-report:\r?\n    description: "Upload the final Aegis audit log as a job artifact"\r?\n    required: false\r?\n    default: "true"/,
  );
  assert.match(manifest, /runs:\r?\n  using: "node24"\r?\n  main: "main\.cjs"\r?\n  post: "post\.cjs"/);
  const { aegisReportPath, artifactName } = require("./dist/artifact-upload.cjs");
  assert.equal(aegisReportPath("linux"), "/var/log/aegis/service.jsonl");
  assert.equal(aegisReportPath("darwin"), "/Library/Application Support/Aegis/service.jsonl");
  assert.equal(
    aegisReportPath("win32", { ProgramData: "C:\\ProgramData" }),
    "C:\\ProgramData\\Aegis\\service.jsonl",
  );
  assert.equal(
    artifactName("socket-sts 2", { GITHUB_JOB: "lint / check" }),
    "aegis-service-log-lint---check-socket-sts-2",
  );
  assert.match(fs.readFileSync(path.join(__dirname, "post.cjs"), "utf8"), /STATE_upload_aegis_report/);
});

test("post is a no-op when no token was minted", () => {
  const withoutNode = fs.mkdtempSync(path.join(os.tmpdir(), "socket-sts-no-node-"));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: withoutNode, STATE_token: "" },
    });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /skipping revocation/);
  } finally {
    fs.rmSync(withoutNode, { force: true, recursive: true });
  }
});
