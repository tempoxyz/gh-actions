const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "notify-slack.sh");
const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
const OIDC = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJzbGFjay1ub3RpZmllciJ9.c2ln"; // gitleaks:allow (fake JWT)

// Stand-ins for curl and sleep: each call is logged, and the service's
// answers are taken in order from responses.json.
const FAKE_CURL = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
const value = (flag) => args[args.indexOf(flag) + 1];
const url = args.find((arg) => arg.startsWith("http"));
const call = { url, args };
const data = value("--data-binary");
if (args.includes("--data-binary")) call.body = JSON.parse(fs.readFileSync(data.slice(1), "utf8"));
fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify(call) + "\\n");
if (url.includes("audience=")) {
  process.stdout.write(JSON.stringify({ value: process.env.FAKE_OIDC }));
  process.exit(0);
}
const responses = JSON.parse(fs.readFileSync(dir + "/responses.json", "utf8"));
const next = responses.shift() ?? { status: 500, body: {} };
fs.writeFileSync(dir + "/responses.json", JSON.stringify(responses));
if (next.unreachable) process.exit(7);
fs.writeFileSync(value("-o"), JSON.stringify(next.body));
const headers = Object.entries(next.headers ?? {}).map(([k, v]) => k + ": " + v + "\\r\\n").join("");
fs.writeFileSync(value("-D"), "HTTP/2 " + next.status + "\\r\\n" + headers + "\\r\\n");
process.stdout.write(String(next.status));
`;
const FAKE_SLEEP = `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_DIR + "/sleeps.txt", process.argv[2] + "\\n");
`;

function run(inputs, responses = [ok()], env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notify-slack-"));
  try {
    for (const [name, body] of [
      ["curl", FAKE_CURL],
      ["sleep", FAKE_SLEEP],
    ]) {
      writeFileSync(path.join(dir, name), body);
      chmodSync(path.join(dir, name), 0o755);
    }
    writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
    writeFileSync(path.join(dir, "output"), "");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_DIR: dir,
        FAKE_OIDC: OIDC,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: path.join(dir, "output"),
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?api-version=2.0",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        ...Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [`NOTIFY_${key.toUpperCase()}`, value]),
        ),
        ...env,
      },
    });
    const read = (name) => {
      try {
        return readFileSync(path.join(dir, name), "utf8");
      } catch {
        return "";
      }
    };
    const calls = read("calls.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return {
      status: result.status,
      stdout: result.stdout,
      oidc: calls.filter((call) => call.url.includes("audience=")),
      posts: calls.filter((call) => !call.url.includes("audience=")),
      output: read("output"),
      sleeps: read("sleeps.txt").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ok(channel = "C0123456789") {
  return {
    status: 200,
    body: { ok: true, channel, ts: "1700000000.000100", policy: "deploy", username: "Deploys" },
  };
}

test("posts the given chat.postMessage arguments with the job's OIDC token", () => {
  const result = run({
    channel: "C0123456789",
    text: "Deployed *v1*",
    blocks: '[{"type":"divider"}]',
    thread_ts: "1700000000.000001",
    reply_broadcast: "true",
    unfurl_links: "false",
    metadata: '{"event_type":"deploy","event_payload":{"v":1}}',
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.oidc.length, 1);
  assert.match(result.oidc[0].url, /^https:\/\/oidc\.example\/token\?api-version=2\.0&audience=slack-notifier\.tempoxyz\.net$/);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].url, "https://slack-notifier.tempoxyz.net/v1/messages");
  assert.ok(result.posts[0].args.includes(`Authorization: Bearer ${OIDC}`));
  assert.deepEqual(result.posts[0].body, {
    channel: "C0123456789",
    text: "Deployed *v1*",
    blocks: [{ type: "divider" }],
    thread_ts: "1700000000.000001",
    reply_broadcast: true,
    unfurl_links: false,
    metadata: { event_type: "deploy", event_payload: { v: 1 } },
  });
  assert.equal(result.output, "channel=C0123456789\nts=1700000000.000100\n");
  assert.match(result.stdout, new RegExp(`::add-mask::${OIDC.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, /Posted to C0123456789 as "Deploys"/);
});

test("DMs a member ID and names a policy when asked", () => {
  const result = run({ channel: "U0123ABCD", text: "hi", policy: "deploy" }, [ok("D0123ABCD")]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.posts[0].url, "https://slack-notifier.tempoxyz.net/v1/messages?policy=deploy");
  assert.deepEqual(result.posts[0].body, { channel: "U0123ABCD", text: "hi" });
  assert.equal(result.output, "channel=D0123ABCD\nts=1700000000.000100\n");
});

test("refuses bad inputs before requesting a token", () => {
  for (const [inputs, message] of [
    [{ channel: "general", text: "hi" }, /channel must be/],
    [{ channel: "C1234", text: "hi", blocks: '{"type":"divider"}' }, /blocks must be a JSON array/],
    [{ channel: "C1234", text: "hi", attachments: "not json" }, /attachments must be a JSON array/],
    [{ channel: "C1234", text: "hi", metadata: "[]" }, /metadata must be a JSON object/],
    [{ channel: "C1234", text: "hi", unfurl_media: "yes" }, /unfurl_media must be true or false/],
    [{ channel: "C1234", text: "hi", parse: "client" }, /parse must be none or full/],
    [{ channel: "C1234", text: "hi", thread_ts: "now" }, /thread_ts must be/],
    [{ channel: "C1234", text: "hi", policy: "../x" }, /policy must be/],
    [{ channel: "C1234" }, /one of text, blocks or attachments/],
  ]) {
    const result = run(inputs, []);
    assert.equal(result.status, 1, JSON.stringify(inputs));
    assert.match(result.stdout, message);
    assert.equal(result.oidc.length + result.posts.length, 0);
  }
  const noOidc = run({ channel: "C1234", text: "hi" }, [], { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });
  assert.match(noOidc.stdout, /id-token: write/);
});

test("retries when nothing was posted, with a fresh token each time", () => {
  const result = run({ channel: "C1234", text: "hi" }, [
    { unreachable: true },
    { status: 503, body: { ok: false, error: "service unavailable" } },
    ok(),
  ]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.posts.length, 3);
  assert.equal(result.oidc.length, 3);
  assert.deepEqual(result.sleeps, ["2", "4"]);
});

test("waits out Slack's rate limit", () => {
  const result = run({ channel: "C1234", text: "hi" }, [
    { status: 429, body: { ok: false, error: "Slack rate limited this message" }, headers: { "Retry-After": "9" } },
    ok(),
  ]);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(result.sleeps, ["9"]);
});

test("fails at once with the service's reason for any other answer", () => {
  const result = run({ channel: "C1234", text: "hi" }, [
    { status: 403, body: { ok: false, error: "no policy admits repo:tempoxyz@1/x@2:pull_request\n::warning::x" } },
    ok(),
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.posts.length, 1);
  assert.match(result.stdout, /::error title=notify-slack::slack-notifier answered HTTP 403: no policy admits repo:tempoxyz@1\/x@2:pull_request ::warning::x/);
  assert.equal(result.output, "");
});

test("gives up after three attempts", () => {
  const unavailable = { status: 503, body: { ok: false, error: "service unavailable" } };
  const result = run({ channel: "C1234", text: "hi" }, [unavailable, unavailable, unavailable, ok()]);
  assert.equal(result.status, 1);
  assert.equal(result.posts.length, 3);
  assert.match(result.stdout, /HTTP 503: service unavailable/);
});

test("takes no sender inputs: the slack-notifier policy sets the sender", () => {
  for (const name of ["username", "icon_url", "icon_emoji", "as_user", "token", "host"]) {
    assert.doesNotMatch(action, new RegExp(`^  ${name}:`, "m"), name);
  }
  const section = action.slice(action.indexOf("\ninputs:"), action.indexOf("\noutputs:"));
  const inputs = [...section.matchAll(/^  ([a-z_]+):$/gm)].map((match) => match[1]);
  assert.equal(inputs.length, 13);
  for (const name of inputs) {
    assert.match(action, new RegExp(`NOTIFY_${name.toUpperCase()}: \\$\\{\\{ inputs\\.${name} \\}\\}`), name);
  }
});
