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
  /uses:\s+tempoxyz\/gh-actions\/actions\/secure-runner@[0-9a-f]{40}/;

function usesSecureRunner(filename, visited = new Set()) {
  if (visited.has(filename)) return false;
  visited.add(filename);
  const workflow = fs.readFileSync(
    path.join(workflowsDirectory, filename),
    "utf8",
  );
  if (wrapperPattern.test(workflow)) return true;
  return [...workflow.matchAll(/uses:\s+tempoxyz\/gh-actions\/\.github\/workflows\/([^\s@#]+)@[0-9a-f]{40}/g)].some(
    (match) => usesSecureRunner(match[1], visited),
  );
}

function isEnsureSecureRunnerJob(jobBlock) {
  const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1];
  if (!steps || /^\s+run:/m.test(steps)) return false;
  const uses = [...steps.matchAll(/^\s+(?:- )?uses:\s+(\S+)/gm)].map((m) => m[1]);
  return (
    uses.length > 0 &&
    uses.some((u) => /^tempoxyz\/gh-actions\/actions\/ensure-secure-runner@[0-9a-f]{40}$/.test(u)) &&
    uses.every((u) => /^tempoxyz\/gh-actions\/actions\/ensure-secure-runner@[0-9a-f]{40}$/.test(u) || u.startsWith("actions/checkout@"))
  );
}

for (const check of ["fmt", "clippy"]) {
  test(`${check} wrapper enables only its check and forwards its inputs`, () => {
    const workflow = fs.readFileSync(
      path.join(workflowsDirectory, `rust-${check}.yml`),
      "utf8",
    );
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.match(workflow, /uses: tempoxyz\/gh-actions\/\.github\/workflows\/rust-lint\.yml@[0-9a-f]{40}/);
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
    /step-security-sts-host:\n\s+description:[^\n]+\n\s+required: false\n\s+default: "ss-sts\.tempoxyz\.net"/,
  );
  assert.doesNotMatch(manifest, /\bdev:/);
  assert.match(manifest, /using: "node24"/);
  assert.match(manifest, /pre: "pre\.cjs"/);
  const pre = fs.readFileSync(path.join(__dirname, "pre.cjs"), "utf8");
  assert.ok(
    pre.indexOf("await exchange(") <
      pre.indexOf("startHardenRunner(run, result.token, env)"),
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
  const implementation = ["pre.cjs", "main.cjs", "post.cjs", "run.cjs", "annotations.cjs"]
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
          rawHost: "ss-sts.tempoxyz.net",
        };
      },
    }),
  );
  assert.deepEqual(endpoints, ["ss-sts.tempoxyz.net"]);
  assert.deepEqual(calls, [["pre", "step_test_short_lived_api_key"]]);
  assert.equal(
    fs.readFileSync(state, "utf8"),
    "token=step_test_short_lived_api_key\n" +
      "lease_id=11111111-1111-4111-8111-111111111111\n" +
      "sts_host=ss-sts.tempoxyz.net\n",
  );
});

test("skips Harden Runner cleanly on Windows ARM64", async () => {
  const calls = [];
  const state = stateFile();
  const { lines } = await capturedLogs(() =>
    preMain({
      env: {
        ...oidcEnv,
        GITHUB_STATE: state,
        RUNNER_OS: "Windows",
        RUNNER_ARCH: "ARM64",
      },
      run: (...args) => calls.push(args),
      exchange: async () => {
        throw new Error("the STS must not be contacted on an unsupported runner");
      },
    }),
  );

  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(state, "utf8"), "unsupported_platform=true\n");
  assert.ok(
    lines.some((line) => /^::warning::Harden Runner does not support Windows ARM64/.test(line)),
    lines.join("\n"),
  );

  mainMain({
    env: { STATE_unsupported_platform: "true" },
    run: (...args) => calls.push(args),
  });
  let revocations = 0;
  await postMain({
    env: { STATE_unsupported_platform: "true" },
    run: (...args) => calls.push(args),
    revoke: async () => {
      revocations += 1;
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(revocations, 0);
});

test("explicit disable-enforcement mode skips every Harden Runner entrypoint", async () => {
  const calls = [];
  const state = stateFile();
  const { lines } = await capturedLogs(() =>
    preMain({
      env: {
        ...oidcEnv,
        GITHUB_STATE: state,
        "INPUT_DISABLE-ENFORCEMENT": "true",
      },
      run: (...args) => calls.push(args),
      exchange: async () => {
        throw new Error("the STS must not be contacted when enforcement is disabled");
      },
    }),
  );

  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(state, "utf8"), "enforcement_disabled=true\n");
  assert.ok(
    lines.some((line) => /^::warning::Runner security enforcement was explicitly disabled/.test(line)),
    lines.join("\n"),
  );

  mainMain({
    env: { STATE_enforcement_disabled: "true" },
    run: (...args) => calls.push(args),
  });
  let revocations = 0;
  await postMain({
    env: { STATE_enforcement_disabled: "true" },
    run: (...args) => calls.push(args),
    revoke: async () => {
      revocations += 1;
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(revocations, 0);
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
      /uses:\s+(?:step-security\/harden-runner|tempoxyz\/gh-actions\/actions\/harden-runner@)/,
      `${filename} must use the Secure Runner wrapper`,
    );
    assert.doesNotMatch(workflow, /STEP_SECURITY_STS_(?:DEV|PRD)_URL/);

    const jobBlocks = workflow.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    for (const jobBlock of jobBlocks) {
      const runsOnRunner = /^    runs-on:/m.test(jobBlock);
      const reusableWorkflow = jobBlock.match(
        /uses:\s+tempoxyz\/gh-actions\/\.github\/workflows\/([^\s@#]+)@[0-9a-f]{40}/,
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
            "^(?:\\s*#[^\\n]*\\n)*\\s*- (?:name:[^\\n]+\\n\\s+)?uses:\\s+tempoxyz/gh-actions/actions/secure-runner@[0-9a-f]{40}[^\\n]*",
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

const degradedAnnotation = (host, reason, policy = "audit") =>
  "::warning title=StepSecurity policy store unavailable::" +
  `Could not obtain a StepSecurity policy-store credential from ${host}: ` +
  `${reason}. Harden Runner is running in ${policy} mode from the workflow's ` +
  "inline egress policy, without the StepSecurity policy store, so stored " +
  "egress policies are not applied to this job.";

test("pre degrades to the inline policy whenever no STS credential can be obtained", async () => {
  const failures = [
    ["push", "Step Security STS exchange failed (HTTP 503): upstream\nunavailable"],
    ["pull_request", "Step Security STS exchange failed: HTTPS request timed out"],
    ["workflow_dispatch", "Step Security STS exchange failed: HTTPS request failed"],
    ["push", "Step Security STS exchange failed: Rate limit retry delay (121s) exceeds the 2 minute limit"],
    ["push", "Step Security STS response is invalid"],
    ["push", "Step Security STS exchange failed (HTTP 403): repository is not authorized"],
    ["push", "Step Security STS exchange failed (HTTP 404)"],
    ["push", "GitHub OIDC request failed (HTTP 401)"],
    ["push", "GitHub OIDC request failed: HTTPS request timed out"],
  ];
  for (const [event, reason] of failures) {
    const calls = [];
    const state = stateFile();
    const { lines } = await capturedLogs(() =>
      preMain({
        env: {
          ...oidcEnv,
          GITHUB_EVENT_NAME: event,
          GITHUB_STATE: state,
          "INPUT_STEP-SECURITY-STS-HOST": "ss-sts.tempoxyz.dev",
        },
        run: (...args) => calls.push(args),
        exchange: async () => {
          throw new Error(reason);
        },
      }),
    );

    assert.deepEqual(calls, [["pre", null]], reason);
    assert.equal(fs.readFileSync(state, "utf8"), "inline_policy=true\n", reason);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("::")),
      [degradedAnnotation("ss-sts.tempoxyz.dev", reason.replaceAll("\n", "%0A"))],
      reason,
    );
  }
});

test("the degraded annotation names the caller's inline egress policy", async () => {
  const state = stateFile();
  const { lines } = await capturedLogs(() =>
    preMain({
      env: {
        ...oidcEnv,
        GITHUB_STATE: state,
        "INPUT_EGRESS-POLICY": "block",
      },
      run: () => {},
      exchange: async () => {
        throw new Error("Step Security STS exchange failed (HTTP 502)");
      },
    }),
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith("::")),
    [
      degradedAnnotation(
        "ss-sts.tempoxyz.net",
        "Step Security STS exchange failed (HTTP 502)",
        "block",
      ),
    ],
  );
});

test("pre still fails on an invalid STS host input before any request", async () => {
  const calls = [];
  const state = stateFile();
  const { lines } = await capturedLogs(() =>
    assert.rejects(
      preMain({
        env: {
          ...oidcEnv,
          GITHUB_STATE: state,
          "INPUT_STEP-SECURITY-STS-HOST": "https://ss-sts.tempoxyz.net",
        },
        run: (...args) => calls.push(args),
        exchange: async () => {
          throw new Error("the STS must not be contacted with an invalid host");
        },
      }),
      /host must be a hostname/,
    ),
  );
  assert.deepEqual(calls, []);
  assert.ok(!fs.existsSync(state));
  assert.deepEqual(lines.filter((line) => line.startsWith("::")), []);
});

test("main and post treat a degraded run like the fork fallback", async () => {
  const calls = [];
  const run = (...args) => calls.push(args);
  mainMain({ env: { STATE_inline_policy: "true" }, run });
  let revocations = 0;
  await postMain({
    env: { STATE_inline_policy: "true", STATE_token: "" },
    run,
    revoke: async () => {
      revocations += 1;
    },
  });
  assert.deepEqual(calls, [["main", null], ["post", null]]);
  assert.equal(revocations, 1);
});

const startFailure = (phase) => {
  throw new Error(`Harden Runner ${phase} failed (exit 1)`);
};
const startFailedAnnotation =
  "::warning title=Harden Runner unavailable::Harden Runner did not start " +
  "(Harden Runner pre failed (exit 1)). This job is running without Harden " +
  "Runner's runtime monitoring and egress enforcement.";

test("pre degrades when Harden Runner's own pre-job entrypoint fails", async () => {
  const state = stateFile();
  const { lines } = await capturedLogs(() =>
    preMain({
      env: { ...oidcEnv, GITHUB_STATE: state },
      run: startFailure,
      exchange: async () => ({
        token: "step_test_short_lived_api_key",
        leaseId: "11111111-1111-4111-8111-111111111111",
        rawHost: "ss-sts.tempoxyz.net",
      }),
    }),
  );
  assert.equal(
    fs.readFileSync(state, "utf8"),
    "token=step_test_short_lived_api_key\n" +
      "lease_id=11111111-1111-4111-8111-111111111111\n" +
      "sts_host=ss-sts.tempoxyz.net\n" +
      "start_failed=true\n",
    "the lease must stay recorded so the post hook still revokes it",
  );
  assert.deepEqual(lines.filter((line) => line.startsWith("::warning")), [startFailedAnnotation]);

  // The inline-policy fallback degrades the same way.
  const forkState = stateFile();
  const fork = await capturedLogs(() =>
    preMain({
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_STATE: forkState },
      run: startFailure,
      exchange: async () => assert.fail("no OIDC token, so no exchange"),
    }),
  );
  assert.equal(fs.readFileSync(forkState, "utf8"), "inline_policy=true\nstart_failed=true\n");
  const forkWarnings = fork.lines.filter((line) => line.startsWith("::warning"));
  assert.equal(forkWarnings.length, 2, fork.lines.join("\n"));
  assert.match(forkWarnings[0], /^::warning::GitHub issued no OIDC token/);
  assert.equal(forkWarnings[1], startFailedAnnotation);
});

test("main skips Harden Runner after a failed start", () => {
  const calls = [];
  const run = (...args) => calls.push(args);
  mainMain({ env: { STATE_start_failed: "true", STATE_token: "step_test_short_lived_api_key" }, run });
  mainMain({ env: { STATE_start_failed: "true", STATE_inline_policy: "true" }, run });
  assert.deepEqual(calls, []);
});

test("post cleans up best-effort after a failed start and still revokes the lease", async () => {
  let revocations = 0;
  const revoke = async () => {
    revocations += 1;
  };
  const run = (phase) => {
    throw new Error(`Harden Runner ${phase} failed (exit 1)`);
  };

  const { lines } = await capturedLogs(() =>
    postMain({
      env: { STATE_start_failed: "true", STATE_token: "step_test_short_lived_api_key" },
      run,
      revoke,
    }),
  );
  assert.equal(revocations, 1);
  assert.deepEqual(lines.filter((line) => line.startsWith("::warning")), [
    "::warning title=Harden Runner unavailable::Harden Runner post-job cleanup failed " +
      "after Harden Runner did not start (Harden Runner post failed (exit 1)).",
  ]);

  // A post-job failure after a normal start still fails the job.
  await assert.rejects(
    postMain({ env: { STATE_token: "step_test_short_lived_api_key" }, run, revoke }),
    /Harden Runner post failed/,
  );
  assert.equal(revocations, 2, "revocation is attempted even when cleanup fails");
});
