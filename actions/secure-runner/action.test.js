const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createOidcClient, expiresAt } = require("./oidc.cjs");
const { STAGES, assertionProvider, forkPullRequest, main: mainMain } = require("./main.cjs");
const { AUDIENCE: AEGIS_AUDIENCE } = require("./aegis-release.cjs");
const { main: postMain } = require("./post.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8").replace(/\r\n/g, "\n");
const hardenRunnerManifest = fs
  .readFileSync(path.join(__dirname, "../harden-runner/action.yml"), "utf8")
  .replace(/\r\n/g, "\n");

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "secure-runner-")), name);
}

function captured(callback) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      console.log = original;
    })
    .then((value) => ({ value, lines }));
}

const jwt = (exp, aud = "x") =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp, aud })).toString("base64url")}.c2ln`;

const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
};

test("is a node24 action with no pre hook or nested pins and the expected inputs and outputs", () => {
  assert.match(manifest, /runs:\n  using: "node24"\n  main: "main\.cjs"\n  post: "post\.cjs"\n/);
  assert.doesNotMatch(manifest, /^  pre:/m);
  assert.doesNotMatch(manifest, /uses:/);
  const inputs = (text) => [...text.matchAll(/^  ([a-z-]+):\n    description: "[^"]+"\n    required: false\n    default: (.*)$/gm)].map((m) => [m[1], m[2]]);
  const ours = inputs(manifest.split("\nruns:")[0]);
  const hardenRunners = inputs(hardenRunnerManifest.split("\nruns:")[0]);
  for (const [name, fallback] of hardenRunners) {
    assert.deepEqual(ours.find((input) => input[0] === name), [name, fallback], `input ${name} must match harden-runner`);
  }
  assert.deepEqual(ours.find((input) => input[0] === "socket-sts-host"), ["socket-sts-host", '"socket-sts.tempoxyz.net"']);
  assert.deepEqual(ours.find((input) => input[0] === "aegis-version"), ["aegis-version", '""']);
  assert.equal(ours.length, hardenRunners.length + 2);
  assert.doesNotMatch(manifest, /^outputs:/m, "the action exposes no outputs; nothing consumes them");
  assert.doesNotMatch(manifest, /\bdev:/);
  const implementation = ["main.cjs", "post.cjs", "oidc.cjs"]
    .map((filename) => fs.readFileSync(path.join(__dirname, filename), "utf8"))
    .join("\n");
  assert.doesNotMatch(implementation, /GITHUB_ENV|STEPSECURITY_API_KEY/);
  assert.ok(!fs.existsSync(path.join(__dirname, "DESIGN.md")));
});

test("the OIDC client shares in-flight requests per audience, reuses valid assertions, and refreshes on demand", async () => {
  let now = 1_800_000_000_000;
  const requests = [];
  const client = createOidcClient({
    env: oidcEnv,
    now: () => now,
    request: async (url) => {
      requests.push(url.searchParams.get("audience"));
      return { status: 200, headers: {}, body: JSON.stringify({ value: jwt(Math.floor(now / 1000) + 300, requests.length) }) };
    },
  });
  assert.equal(client.available(), true);
  const [a, b, c] = await Promise.all([client.token("ss-sts"), client.token("ss-sts"), client.token("socket-sts")]);
  assert.equal(a, b, "concurrent callers share one request");
  assert.notEqual(a, c, "different audiences get different assertions");
  assert.deepEqual(requests, ["ss-sts", "socket-sts"]);

  assert.equal(await client.token("ss-sts"), a, "a valid assertion is reused");
  assert.notEqual(await client.token("ss-sts", { fresh: true }), a, "fresh bypasses the cache");
  assert.equal(requests.length, 3);
  now += 271_000;
  await client.token("socket-sts");
  assert.equal(requests.length, 4, "an assertion near expiry is refetched");
  assert.equal(expiresAt("not-a-jwt"), 0);
  assert.equal(expiresAt(jwt(12)), 12_000);
});

test("the OIDC client reports failures with their cause and does not cache them", async () => {
  let attempts = 0;
  const failing = createOidcClient({
    env: oidcEnv,
    now: () => 0,
    sleep: async () => {},
    random: () => 0,
    request: async () => {
      attempts += 1;
      return { status: 503, headers: {}, body: "" };
    },
  });
  await assert.rejects(failing.token("aud"), { message: "GitHub OIDC request failed (HTTP 503)" });
  assert.equal(attempts, 4);
  await assert.rejects(failing.token("aud"), /HTTP 503/);
  assert.equal(attempts, 8, "a failed fetch is not cached");

  const unavailable = createOidcClient({ env: {}, request: async () => assert.fail("no request") });
  assert.equal(unavailable.available(), false);
  await assert.rejects(unavailable.token("aud"), /id-token: write/);
  await assert.rejects(failing.token(""), /audience is required/);
  const malformed = createOidcClient({ env: oidcEnv, request: async () => ({ status: 200, headers: {}, body: "{}" }) });
  await assert.rejects(malformed.token("aud"), /GitHub OIDC response is invalid/);
  await assert.rejects(
    createOidcClient({ env: oidcEnv, sleep: async () => {}, now: () => 0, request: async () => { throw new Error("HTTPS request timed out"); } }).token("aud"),
    { message: "GitHub OIDC request failed: HTTPS request timed out" },
  );
});

test("main overlaps both installers and waits for both before returning", async () => {
  const { env, config } = pipelineEnv();
  const hardenStarted = Promise.withResolvers();
  const installStarted = Promise.withResolvers();
  const releaseHarden = Promise.withResolvers();
  const releaseInstall = Promise.withResolvers();
  const { deps } = pipelineDeps({
    startHardenRunner: async () => { hardenStarted.resolve(); await releaseHarden.promise; },
    prepareConfig: async () => config,
    install: async () => {
      installStarted.resolve();
      await releaseInstall.promise;
      return { binary: "/usr/bin/aegis" };
    },
  });
  let finished = false;
  const running = mainMain({ env, platform: "linux", deps }).then(() => { finished = true; });
  await Promise.all([hardenStarted.promise, installStarted.promise]);
  assert.equal(finished, false, "Aegis reaches installation while StepSecurity is still running");
  releaseInstall.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "finishing Aegis must not advance the workflow past StepSecurity");
  releaseHarden.resolve();
  await running;
});

test("a fatal setup failure waits for the other branch to finish and record cleanup state", async () => {
  for (const failedBranch of ["harden", "aegis"]) {
    const { env, config } = pipelineEnv();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const state = "other_branch_finished=true\n";
    const finish = async () => {
      started.resolve();
      await release.promise;
      fs.appendFileSync(env.GITHUB_STATE, state);
      return { binary: "/usr/bin/aegis" };
    };
    const { deps } = pipelineDeps({
      startHardenRunner: failedBranch === "harden" ? async () => { throw new Error("harden failed"); } : finish,
      prepareConfig: async () => config,
      install: finish,
    });
    // Missing state is a fatal Aegis configuration error, not a degraded stage.
    const effectiveEnv = failedBranch === "aegis" ? { ...env, GITHUB_STATE: "" } : env;
    let settled = false;
    const running = mainMain({ env: effectiveEnv, platform: "linux", deps }).then(
      () => { settled = true; assert.fail("must reject"); },
      (error) => { settled = true; return error; },
    );
    await started.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, failedBranch);
    release.resolve();
    const error = await running;
    assert.match(error.message, failedBranch === "harden" ? /harden failed/ : /GITHUB_STATE/);
    assert.ok(fs.readFileSync(env.GITHUB_STATE, "utf8").endsWith(state));
  }
});

function pipelineDeps(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    if (typeof result === "function") return result(...args);
    return result;
  };
  const tokens = [];
  const oidc = {
    token: async (audience, options = {}) => {
      tokens.push([audience, options.fresh === true]);
      return `assertion-${audience}-${tokens.length}`;
    },
  };
  const deps = {
    oidc,
    startHardenRunner: async () => {},
    sleep: async () => {},
    spawn: () => ({ status: 0 }),
    exchangeSocket: record("socket", async ({ getAssertion }) => {
      await getAssertion();
      return { token: "sktsec_test_short_lived_token_api", expiresAt: "2026-09-26T00:00:00Z" };
    }),
    ensureCli: record("cli", ["/bootstrap/gh/bin"]),
    download: record("download", { package: "/runner/temp/aegis-release-x/aegis-1.2.3-linux-amd64.deb", directory: "/runner/temp/aegis-release-x" }),
    prepareConfig: record("provider", null),
    readIdentity: (config) => `identity-of-${config.test_token_url}`,
    retireIncumbent: record("retire", undefined),
    install: record("install", { binary: "/usr/bin/aegis", report: "/var/log/aegis/service.jsonl" }),
    ...overrides,
  };
  return { calls, tokens, deps };
}

function pipelineEnv(extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secure-runner-main-"));
  const config = path.join(directory, "install.json");
  fs.writeFileSync(config, JSON.stringify({ managers: ["npm"], test_token_url: "http://127.0.0.1:1/route" }));
  return {
    directory,
    config,
    env: {
      ...oidcEnv,
      GITHUB_STATE: path.join(directory, "state"),
      GITHUB_OUTPUT: path.join(directory, "output"),
      GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
      GITHUB_ACTION: "__tempoxyz_gh-actions_actions_secure-runner",
      GITHUB_EVENT_NAME: "push",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      RUNNER_TEMP: directory,
      ...extra,
    },
  };
}

test("main runs the Aegis pipeline in order and records state and masks", async () => {
  const { env, config, directory } = pipelineEnv({ "INPUT_SOCKET-STS-HOST": "socket-sts.tempoxyz.dev" });
  const { calls, tokens, deps } = pipelineDeps({ prepareConfig: async () => config });
  const { lines } = await captured(() => mainMain({ env, platform: "linux", deps }));

  assert.deepEqual(calls.map((call) => call[0]), ["socket", "cli", "download", "retire", "install"]);
  const socketCall = calls[0][1];
  assert.equal(socketCall.endpoint, "socket-sts.tempoxyz.dev");
  assert.deepEqual(calls[2][1].pathEntries, ["/bootstrap/gh/bin"]);
  assert.deepEqual([calls[2][1].runnerOS, calls[2][1].runnerArch], ["Linux", "X64"]);
  assert.equal(calls[2][1].version, "");
  assert.equal(calls[4][1].configPath, config);
  assert.equal(calls[4][1].packagePath, "/runner/temp/aegis-release-x/aegis-1.2.3-linux-amd64.deb");

  // Both audiences are warmed up front and served from the cache first; only
  // repeat calls ask for a fresh assertion.
  assert.deepEqual(tokens, [
    ["socket-sts.tempoxyz.dev", false],
    [AEGIS_AUDIENCE, false],
    ["socket-sts.tempoxyz.dev", false],
  ]);

  assert.equal(
    fs.readFileSync(env.GITHUB_STATE, "utf8"),
    "socket_token=sktsec_test_short_lived_token_api\n" +
      "socket_host=socket-sts.tempoxyz.dev\n" +
      "aegis_action=__tempoxyz_gh-actions_actions_secure-runner\n" +
      "aegis_installation_identity=identity-of-http://127.0.0.1:1/route\n",
  );
  assert.ok(!fs.existsSync(env.GITHUB_OUTPUT), "no outputs are written");
  assert.deepEqual(lines.filter((line) => line.startsWith("::")), [
    "::add-mask::sktsec_test_short_lived_token_api",
  ]);
  assert.ok(lines.at(-1).startsWith("Aegis installed at /usr/bin/aegis"));
  assert.ok(!fs.existsSync(env.GITHUB_STEP_SUMMARY));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("main passes an exact Aegis release tag to the server downloader", async () => {
  const { env, config, directory } = pipelineEnv({ "INPUT_AEGIS-VERSION": "20260927T194115Z-5e7bd8b807b2" });
  const { calls, deps } = pipelineDeps({ prepareConfig: async () => config });
  await captured(() => mainMain({ env, platform: "linux", deps }));
  assert.equal(calls.find((call) => call[0] === "download")[1].version, "20260927T194115Z-5e7bd8b807b2");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("main degrades at the failing stage, installs nothing after it, and says why", async () => {
  const failures = [
    ["exchangeSocket", "socket", STAGES.socket, ["socket"], []],
    ["ensureCli", "cli", STAGES.cli, ["socket", "cli"], ["socket_token", "socket_host"]],
    ["download", "download", STAGES.download, ["socket", "cli", "download"], ["socket_token", "socket_host"]],
    ["prepareConfig", "provider", STAGES.provider, ["socket", "cli", "download"], ["socket_token", "socket_host"]],
    ["retireIncumbent", "retire", STAGES.lifecycle, ["socket", "cli", "download", "retire"], ["socket_token", "socket_host", "aegis_action"]],
    ["install", "install", STAGES.install, ["socket", "cli", "download", "retire", "install"], ["socket_token", "socket_host", "aegis_action", "aegis_installation_identity"]],
  ];
  for (const [dep, name, reason, expectedCalls, stateKeys] of failures) {
    const { env, config, directory } = pipelineEnv();
    const failing = async (...args) => {
      throw new Error(`${name} exploded\nwith detail`);
    };
    const { calls, deps } = pipelineDeps({
      prepareConfig: dep === "prepareConfig" ? failing : async () => config,
      [dep]: dep === "prepareConfig" ? failing : (dep === "exchangeSocket" || dep === "ensureCli" || dep === "download" || dep === "install" || dep === "retireIncumbent"
        ? (...args) => { calls.push([name, ...args]); return failing(); }
        : failing),
    });
    const { lines } = await captured(() => mainMain({ env, platform: "linux", deps }));
    assert.deepEqual(calls.map((call) => call[0]), expectedCalls, name);
    const written = fs.existsSync(env.GITHUB_STATE) ? fs.readFileSync(env.GITHUB_STATE, "utf8") : "";
    assert.deepEqual(written.split("\n").filter(Boolean).map((line) => line.split("=")[0]), stateKeys, name);
    const warnings = lines.filter((line) => line.startsWith("::warning"));
    assert.deepEqual(warnings, [
      "::warning title=Package-policy enforcement disabled::Aegis was not installed: " +
        `${reason} (${name} exploded%0Awith detail). No package firewall is running for this job, ` +
        "so package downloads are not inspected or blocked.",
    ], name);
    assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), new RegExp(`^> ⚠️ \\*\\*Package-policy enforcement disabled:\\*\\* Aegis was not installed: ${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${name} exploded with detail\\)`), name);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("main reports a paused STS as disabled with its reason instead of as an outage", async () => {
  const { ServiceDisabledError } = require("../socket-sts/status.cjs");
  const cases = [
    ["exchangeSocket", "Socket STS", "socket-sts.tempoxyz.dev", STAGES.socket, ["socket"]],
  ];
  for (const [dep, service, host, reason, expectedCalls] of cases) {
    const { env, config, directory } = pipelineEnv({ "INPUT_SOCKET-STS-HOST": "socket-sts.tempoxyz.dev" });
    const { calls, deps } = pipelineDeps({
      prepareConfig: async () => config,
      [dep]: (...args) => {
        calls.push(["socket", ...args]);
        throw new ServiceDisabledError(service, host, "Paused");
      },
    });
    const { lines } = await captured(() => mainMain({ env, platform: "linux", deps }));
    assert.deepEqual(calls.map((call) => call[0]), expectedCalls, service);
    const message =
      `The ${service} is disabled: Paused. Aegis was not installed: ${reason}. ` +
      "No package firewall is running for this job, so package downloads are not inspected or blocked.";
    assert.deepEqual(lines.filter((line) => line.startsWith("::warning")), [`::warning title=${service} disabled::${message}`], service);
    assert.equal(fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), `> ⚠️ **${service} disabled:** ${message}\n`, service);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("main skips the firewall when enforcement is disabled and handles runs without OIDC as the composite did", async () => {
  const disabled = pipelineEnv({ "INPUT_DISABLE-ENFORCEMENT": "true" });
  const { calls, deps } = pipelineDeps();
  const quiet = await captured(() => mainMain({ env: disabled.env, platform: "linux", deps }));
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(disabled.env.GITHUB_STATE));
  assert.deepEqual(quiet.lines.filter((line) => line.startsWith("::")), []);

  const event = tempFile("event.json");
  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { repo: { full_name: "fork/gh-actions" } } } }));
  const fork = pipelineEnv({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "tempoxyz/gh-actions" });
  delete fork.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete fork.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  assert.equal(forkPullRequest(fork.env), true);
  const { lines } = await captured(() => mainMain({ env: fork.env, platform: "linux", deps }));
  assert.deepEqual(calls, []);
  assert.deepEqual(lines.filter((line) => line.startsWith("::warning")), [
    "::warning title=Package-policy enforcement disabled::This job is running for a fork pull request, which receives no GitHub OIDC token. No package firewall will be installed; downloads will not be inspected or blocked.",
  ]);
  assert.match(fs.readFileSync(fork.env.GITHUB_STEP_SUMMARY, "utf8"), /^> ⚠️ \*\*Package-policy enforcement disabled:\*\* This job is running for a fork pull request/);

  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { repo: { full_name: "tempoxyz/gh-actions" } } } }));
  assert.equal(forkPullRequest(fork.env), false);
  await assert.rejects(mainMain({ env: fork.env, platform: "linux", deps }), /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing.*event: pull_request/);
  const push = pipelineEnv({ GITHUB_EVENT_NAME: "push" });
  delete push.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  await assert.rejects(mainMain({ env: push.env, platform: "linux", deps }), /id-token: write \(event: push\)/);
  assert.deepEqual(calls, []);
});

test("main fails on an invalid Socket STS host before contacting anything", async () => {
  const { env, directory } = pipelineEnv({ "INPUT_SOCKET-STS-HOST": "https://socket-sts.tempoxyz.net" });
  const { calls, deps } = pipelineDeps();
  await assert.rejects(mainMain({ env, platform: "linux", deps }), /host must be a hostname/);
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(env.GITHUB_STATE));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("main installs on macOS and Windows without the Linux lifecycle retirement", async () => {
  for (const [platform, layout] of [
    ["darwin", { binary: "/usr/local/bin/aegis", report: "/Library/Application Support/Aegis/service.jsonl" }],
    ["win32", { binary: "C:\\Program Files\\Aegis\\aegis.exe", report: "C:\\ProgramData\\Aegis\\service.jsonl" }],
  ]) {
    const { env, config, directory } = pipelineEnv({ RUNNER_OS: platform === "darwin" ? "macOS" : "Windows" });
    const { calls, deps } = pipelineDeps({ prepareConfig: async () => config, install: async () => layout });
    const { lines } = await captured(() => mainMain({ env, platform, deps }));
    assert.deepEqual(calls.map((call) => call[0]), ["socket", "cli", "download"], platform);
    assert.match(fs.readFileSync(env.GITHUB_STATE, "utf8"), /aegis_action=/);
    assert.doesNotMatch(fs.readFileSync(env.GITHUB_STATE, "utf8"), /aegis_installation_identity/);
    assert.equal(lines.at(-1), `Aegis installed at ${layout.binary}; runtime warning verdicts are reported at job end.`, platform);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("assertionProvider serves the warmed assertion once and fresh ones afterwards", async () => {
  const seen = [];
  const provider = assertionProvider({ token: async (audience, options) => { seen.push([audience, options.fresh]); return "a"; } }, "aud");
  await provider();
  await provider();
  await provider();
  assert.deepEqual(seen, [["aud", false], ["aud", true], ["aud", true]]);
});

test("post runs the cleanups in reverse start order with each piece's own state, and reports every failure", async () => {
  const order = [];
  const envs = {};
  const hooks = {
    aegis: async ({ env, platform }) => { order.push("aegis"); envs.aegis = { env, platform }; },
    socket: async ({ env }) => { order.push("socket"); envs.socket = env; },
    hardenRunner: async ({ env, revoke }) => { order.push("harden-runner"); envs.hardenRunner = env; await revoke(); },
    revokeLease: async ({ env }) => { order.push("lease"); envs.lease = env; },
  };
  const env = {
    STATE_token: "step_test_short_lived_api_key",
    STATE_lease_id: "11111111-1111-4111-8111-111111111111",
    STATE_sts_host: "ss-sts.tempoxyz.net",
    STATE_socket_token: "sktsec_test_short_lived_token_api",
    STATE_socket_host: "socket-sts.tempoxyz.net",
    STATE_aegis_action: "secure-runner",
    STATE_aegis_installation_identity: "abc",
    RUNNER_ENVIRONMENT: "github-hosted",
  };
  await postMain({ env, platform: "linux", hooks });
  assert.deepEqual(order, ["aegis", "socket", "harden-runner", "lease"]);
  assert.equal(envs.aegis.env.STATE_action, "secure-runner");
  assert.equal(envs.aegis.env.STATE_installation_identity, "abc");
  assert.equal(envs.aegis.platform, "linux");
  assert.equal(envs.socket.STATE_token, "sktsec_test_short_lived_token_api");
  assert.equal(envs.socket.STATE_host, "socket-sts.tempoxyz.net");
  assert.equal(envs.socket.STATE_upload_aegis_report, "false");
  assert.equal(envs.hardenRunner.STATE_token, "step_test_short_lived_api_key", "Harden Runner sees the Step Security lease");
  assert.equal(envs.lease.STATE_token, "step_test_short_lived_api_key");

  // Pieces that never started are skipped; Harden Runner's hook always runs.
  order.length = 0;
  await postMain({ env: { STATE_inline_policy: "true" }, platform: "linux", hooks });
  assert.deepEqual(order, ["harden-runner", "lease"]);

  // Every cleanup runs even when earlier ones fail, and all failures surface.
  order.length = 0;
  await assert.rejects(
    postMain({
      env,
      platform: "linux",
      hooks: {
        ...hooks,
        aegis: async () => { order.push("aegis"); throw new Error("uninstall failed"); },
        socket: async () => { order.push("socket"); throw new Error("stored Socket token is invalid"); },
      },
    }),
    (error) => error instanceof AggregateError && error.errors.length === 2 && /Aegis cleanup: uninstall failed/.test(error.errors[0].message) && /Socket token revocation: stored Socket token is invalid/.test(error.errors[1].message),
  );
  assert.deepEqual(order, ["aegis", "socket", "harden-runner", "lease"]);
});
