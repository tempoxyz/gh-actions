const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const os = require("node:os");
const { hardenRunnerEnv } = require("./run.cjs");
const { main: preMain } = require("./pre.cjs");
const { main: mainMain } = require("./main.cjs");
const { main: postMain } = require("./post.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/secure-runner@1f3fe279c3cf5b1730b33e2647510347a844da86/;

function usesSecureRunner(filename, visited = new Set()) {
  if (visited.has(filename)) return false;
  visited.add(filename);
  const workflow = fs.readFileSync(
    path.join(workflowsDirectory, filename),
    "utf8",
  );
  if (wrapperPattern.test(workflow)) return true;
  return [...workflow.matchAll(/uses:\s+\.\/\.github\/workflows\/([^\s]+)/g)].some(
    (match) => usesSecureRunner(match[1], visited),
  );
}

function isEnsureSecureRunnerJob(jobBlock) {
  const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1];
  if (!steps || /^\s+run:/m.test(steps)) return false;
  const uses = [...steps.matchAll(/^\s+(?:- )?uses:\s+(\S+)/gm)].map((m) => m[1]);
  return (
    uses.length > 0 &&
    uses.includes("./actions/ensure-secure-runner") &&
    uses.every((u) => u === "./actions/ensure-secure-runner" || u.startsWith("actions/checkout@"))
  );
}

for (const check of ["fmt", "clippy"]) {
  test(`${check} wrapper enables only its check and forwards its inputs`, () => {
    const workflow = fs.readFileSync(
      path.join(workflowsDirectory, `rust-${check}.yml`),
      "utf8",
    );
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/rust-lint\.yml/);
    assert.doesNotMatch(workflow, /\n    (?:steps|runs-on):/);
    for (const candidate of ["clippy", "fmt", "typos", "deny"]) {
      assert.match(
        workflow,
        new RegExp(`^      run-${candidate}: ${candidate === check}$`, "m"),
      );
    }
    const mappings = {
      "rust-toolchain": "rust-toolchain",
      [`${check}-flags`]: "flags",
      [`${check}-runner`]: "runner",
      "timeout-minutes": "timeout-minutes",
      ...(check === "clippy"
        ? { "checkout-submodules": "checkout-submodules" }
        : {}),
    };
    for (const [target, input] of Object.entries(mappings)) {
      assert.ok(workflow.includes(target + ": ${{ inputs." + input + " }}"));
      assert.match(workflow, new RegExp(`^      ${input}:\\n`, "m"));
    }
    assert.match(
      workflow,
      /rust-toolchain:\n(?:        [^\n]+\n)*        default: nightly/,
    );
    assert.match(
      workflow,
      /runner:\n(?:        [^\n]+\n)*        default: ubuntu-latest/,
    );
    assert.match(workflow, /      contents: read\n      id-token: write/);
    assert.ok(usesSecureRunner(`rust-${check}.yml`));
  });
}

test("exchanges the STS credential before Harden Runner's pre-job hook", () => {
  assert.match(
    manifest,
    /dev:\n\s+description:[^\n]+\n\s+required: false\n\s+default: "false"/,
  );
  assert.doesNotMatch(manifest, /sts-url:/);
  assert.match(manifest, /using: "node24"/);
  assert.match(manifest, /pre: "pre\.cjs"/);
  const pre = fs.readFileSync(path.join(__dirname, "pre.cjs"), "utf8");
  assert.ok(
    pre.indexOf("await exchange(stsEndpoint(") <
      pre.indexOf('run("pre", result.token)'),
    "the STS exchange must finish before Harden Runner initializes",
  );
  const env = hardenRunnerEnv("step_test_short_lived_api_key", {
    EXISTING: "preserved",
  });
  assert.equal(env["INPUT_API-KEY"], "step_test_short_lived_api_key");
  assert.equal(env["INPUT_USE-POLICY-STORE"], "true");
  assert.equal(env.EXISTING, "preserved");
  assert.ok(
    fs.existsSync(
      path.join(
        __dirname,
        "../../vendor/step-security/harden-runner/dist/pre/index.js",
      ),
    ),
    "the pinned Harden Runner pre-job bundle must be vendored",
  );
  const implementation = ["pre.cjs", "main.cjs", "post.cjs", "run.cjs"]
    .map((filename) => fs.readFileSync(path.join(__dirname, filename), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    `${manifest}\n${implementation}`,
    /harden-runner-token|STEPSECURITY_API_KEY|GITHUB_ENV/,
  );
});

function stateFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "harden-runner-"));
  return path.join(directory, "state");
}

function capturedLogs(callback) {
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

const oidcEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/oidc",
};

test("runs Harden Runner with the inline policy when no OIDC token is available", () => {
  const env = hardenRunnerEnv(null, {
    "INPUT_API-KEY": "must-not-leak",
    "INPUT_EGRESS-POLICY": "block",
    "INPUT_ALLOWED-ENDPOINTS": "github.com:443",
  });
  assert.equal(env["INPUT_API-KEY"], undefined);
  assert.equal(env["INPUT_USE-POLICY-STORE"], "false");
  assert.equal(env["INPUT_DISABLE-SUDO"], "false");
  assert.equal(env["INPUT_EGRESS-POLICY"], "block");
  assert.equal(env["INPUT_ALLOWED-ENDPOINTS"], "github.com:443");
  assert.throws(() => hardenRunnerEnv(""), /API key is invalid/);
});

test("pre falls back to the inline policy only for pull_request runs without OIDC", async () => {
  const calls = [];
  const run = (...args) => calls.push(args);
  const exchange = async () => {
    throw new Error("the STS must not be contacted without an OIDC token");
  };

  const pushState = stateFile();
  await assert.rejects(
    preMain({
      env: { GITHUB_EVENT_NAME: "push", GITHUB_STATE: pushState },
      run,
      exchange,
    }),
    /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing.*id-token: write.*event: push/,
  );
  await assert.rejects(
    preMain({
      env: { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_STATE: pushState },
      run,
      exchange,
    }),
    /id-token: write/,
  );
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(pushState));

  const prState = stateFile();
  const { lines } = await capturedLogs(() =>
    preMain({
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_STATE: prState },
      run,
      exchange,
    }),
  );
  assert.deepEqual(calls, [["pre", null]]);
  assert.equal(fs.readFileSync(prState, "utf8"), "inline_policy=true\n");
  assert.ok(
    lines.some((line) => /^::warning::.*fork pull requests never receive one/.test(line)),
    lines.join("\n"),
  );
});

test("pre exchanges the STS credential whenever an OIDC token is available", async () => {
  const calls = [];
  const endpoints = [];
  const state = stateFile();
  await capturedLogs(() =>
    preMain({
      env: { ...oidcEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_STATE: state },
      run: (...args) => calls.push(args),
      exchange: async (endpoint) => {
        endpoints.push(endpoint);
        return {
          token: "step_test_short_lived_api_key",
          leaseId: "11111111-1111-4111-8111-111111111111",
          rawEndpoint: "https://sts.example.test",
        };
      },
    }),
  );
  assert.deepEqual(endpoints, ["https://ss-sts.tehq.net"]);
  assert.deepEqual(calls, [["pre", "step_test_short_lived_api_key"]]);
  assert.equal(
    fs.readFileSync(state, "utf8"),
    "token=step_test_short_lived_api_key\n" +
      "lease_id=11111111-1111-4111-8111-111111111111\n" +
      "sts_url=https://sts.example.test\n",
  );
});

test("main and post honour the inline-policy state", async () => {
  const calls = [];
  const run = (...args) => calls.push(args);

  mainMain({ env: { STATE_inline_policy: "true" }, run });
  mainMain({ env: { STATE_token: "step_test_short_lived_api_key" }, run });
  assert.throws(() => mainMain({ env: {}, run }), /STATE_token is missing/);
  assert.deepEqual(calls, [
    ["main", null],
    ["main", "step_test_short_lived_api_key"],
  ]);

  calls.length = 0;
  let revocations = 0;
  const revoke = async () => {
    revocations += 1;
  };
  await postMain({ env: { STATE_inline_policy: "true" }, run, revoke });
  await postMain({ env: { STATE_token: "step_test_short_lived_api_key" }, run, revoke });
  await postMain({ env: {}, run, revoke });
  assert.deepEqual(calls, [
    ["post", null],
    ["post", "step_test_short_lived_api_key"],
  ]);
  assert.equal(revocations, 3);
});

test("post cleanup succeeds when the STS exchange did not mint a token", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "post.cjs")], {
    encoding: "utf8",
    env: { ...process.env, STATE_token: "" },
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /stored Step Security API key is invalid/,
  );
});

test("every repository workflow job uses the production Secure Runner wrapper", () => {
  let runnableJobs = 0;
  let protectedJobs = 0;

  for (const filename of fs
    .readdirSync(workflowsDirectory)
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))) {
    const workflow = fs.readFileSync(
      path.join(workflowsDirectory, filename),
      "utf8",
    );

    assert.doesNotMatch(
      workflow,
      /uses:\s+(?:step-security\/harden-runner|tempoxyz\/gh-actions\/actions\/(?:harden-runner|socket-firewall))@/,
      `${filename} must use the Secure Runner wrapper`,
    );
    assert.doesNotMatch(workflow, /STEP_SECURITY_STS_(?:DEV|PRD)_URL/);

    const jobBlocks = workflow.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    for (const jobBlock of jobBlocks) {
      const runsOnRunner = /^    runs-on:/m.test(jobBlock);
      const reusableWorkflow = jobBlock.match(
        /uses:\s+\.\/\.github\/workflows\/([^\s]+)/,
      );
      const usesProtectedWorkflow =
        reusableWorkflow &&
        usesSecureRunner(reusableWorkflow[1]);
      if (!runsOnRunner && !reusableWorkflow) continue;

      runnableJobs += 1;
      // The job that runs ensure-secure-runner is the one job allowed to skip the wrapper: it
      // only checks out the repository and reads workflow files, and the check itself passes
      // such a job only while its steps are nothing but checkout and ensure-secure-runner.
      if (isEnsureSecureRunnerJob(jobBlock)) {
        protectedJobs += 1;
        continue;
      }
      assert.match(
        jobBlock,
        /^    permissions:\n(?:      [^\n]+\n)*      id-token: write$/m,
        `${filename} must grant id-token: write for the STS exchange`,
      );
      if (usesProtectedWorkflow) {
        protectedJobs += 1;
      } else {
        const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1] || "";
        assert.match(
          steps,
          new RegExp(
            String.raw`^(?:\s*#[^\n]*\n)*\s*- (?:name:[^\n]+\n\s+)?uses:\s+tempoxyz/gh-actions/actions/secure-runner@1f3fe279c3cf5b1730b33e2647510347a844da86[^\n]*`,
          ),
          `${filename} must use the Secure Runner wrapper as the first step of every runnable job`,
        );
        protectedJobs += 1;
      }
    }
  }

  assert.ok(runnableJobs > 0, "expected at least one runnable workflow job");
  assert.equal(protectedJobs, runnableJobs);
});
