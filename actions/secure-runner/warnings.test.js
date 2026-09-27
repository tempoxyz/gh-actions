const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { warning } = require("../harden-runner/annotations.cjs");
const { main: mainMain } = require("./main.cjs");
const { main: postMain } = require("./post.cjs");
const aegisPost = require("../aegis-report/post.cjs");
const githubPost = require("../github-sts/post.js");
const socketPost = require("../socket-sts/post.cjs");
const stepSecurityPost = require("../step-security-sts/post.cjs");

async function captured(callback) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await callback();
    return lines;
  } finally {
    console.log = original;
  }
}

function environment(t, setting) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secure-runner-warnings-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    ...(setting === undefined ? {} : { "INPUT_WARNING-ANNOTATIONS": setting }),
    GITHUB_STATE: path.join(directory, "state"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
    RUNNER_TEMP: directory,
    RUNNER_ENVIRONMENT: "github-hosted",
  };
}

test("only an explicit false suppresses annotations and keeps escaped logs and summaries", async (t) => {
  for (const setting of [undefined, "true", "false", "invalid"]) {
    const env = environment(t, setting);
    const lines = await captured(() => warning("first\n::error::second%", "Security", env));
    assert.deepEqual(lines, [setting === "false"
      ? "WARNING: Security: first%0A::error::second%25"
      : "::warning title=Security::first%0A::error::second%25"]);
    assert.equal(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), "> ⚠️ **Security:** first ::error::second%\n");
  }
});

test("quiet setup still starts Harden Runner and attempts the package firewall", async (t) => {
  const env = {
    ...environment(t, "false"),
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
  };
  const calls = [];
  const lines = await captured(() => mainMain({
    env,
    deps: {
      oidc: { token: async () => "assertion" },
      runHardenRunner: (phase, token) => calls.push([phase, token]),
      exchangeStepSecurity: async () => { throw new Error("policy store unavailable"); },
      exchangeSocket: async () => { calls.push(["socket"]); throw new Error("socket unavailable"); },
    },
  }));
  assert.deepEqual(calls, [["pre", null], ["socket"]]);
  assert.equal(lines.filter((line) => line.startsWith("WARNING:")).length, 2);
  assert.equal(lines.filter((line) => line.startsWith("::warning")).length, 0);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(summary, /StepSecurity policy store unavailable/);
  assert.match(summary, /Package-policy enforcement disabled/);
});

test("quiet post keeps reporting, uploads and all credential cleanup attempts", async (t) => {
  const env = {
    ...environment(t, "false"),
    STATE_token: "step_test_short_lived_api_key",
    STATE_lease_id: "11111111-1111-4111-8111-111111111111",
    STATE_sts_host: "ss-sts.tempoxyz.net",
    STATE_socket_token: "sktsec_test_short_lived_token_api",
    STATE_github_token: "ghs_release_token_value_",
    STATE_github_sts_host: "gh-sts.tempoxyz.net",
    STATE_aegis_action: "secure-runner",
    STATE_aegis_installation_identity: "abc",
  };
  const calls = [];
  const lines = await captured(() => postMain({
    env,
    platform: "linux",
    hooks: {
      aegis: (options) => aegisPost.main({
        ...options,
        upload: async () => {
          calls.push("upload");
          fs.writeFileSync(path.join(env.RUNNER_TEMP, "aegis-service.jsonl"), '{"msg":"package decision","action":"warn","reason":"Not connected to internet"}\n');
          throw new Error("upload unavailable");
        },
        cleanup: () => { calls.push("cleanup"); throw new Error("cleanup failed"); },
      }),
      github: (options) => githubPost.main({
        ...options,
        dependencies: {
          request: async () => { calls.push("github"); return 500; },
          retry: (operation) => operation(),
          console: { log() {}, warn() {} },
        },
      }),
      socket: (options) => socketPost.main({
        ...options,
        request: async () => { calls.push("socket"); return { status: 503 }; },
        sleep: async () => {},
      }),
      run: (phase) => calls.push(phase),
      revokeLease: (options) => stepSecurityPost.main({
        ...options,
        request: async () => { calls.push("lease"); return { status: 404 }; },
      }),
    },
  }));
  assert.deepEqual(calls, ["upload", "cleanup", "github", "github", "socket", "socket", "socket", "socket", "post", "lease"]);
  assert.equal(lines.filter((line) => line.startsWith("::warning")).length, 0);
  const titles = ["Aegis audit-log upload failed", "Aegis runtime warning verdicts", "Aegis cleanup failed", "GitHub App token revocation failed", "Socket STS token revocation failed", "Step Security STS lease revocation failed"];
  assert.deepEqual(lines.map((line) => line.split(": ")[1]), titles);
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  for (const title of titles) assert.ok(summary.includes(`**${title}:**`), title);
});

test("quiet mode does not suppress self-hosted cleanup failures", async (t) => {
  await assert.rejects(postMain({
    env: {
      ...environment(t, "false"),
      RUNNER_ENVIRONMENT: "self-hosted",
      STATE_aegis_action: "secure-runner",
      STATE_aegis_installation_identity: "abc",
    },
    hooks: {
      aegis: (options) => aegisPost.main({
        ...options,
        upload: async () => {},
        cleanup: () => { throw new Error("cleanup failed"); },
      }),
      hardenRunner: async () => {},
    },
  }), /Aegis cleanup: cleanup failed/);
});
