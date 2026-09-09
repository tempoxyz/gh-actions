const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { hardenRunnerEnv } = require("./run.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/secure-runner@2b8d302bd3c5ca64e0cb14ae4b1a9fa0a4069500/;

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
    pre.indexOf("await exchangeToken(stsEndpoint())") <
      pre.indexOf('runHardenRunner("pre", result.token)'),
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
            String.raw`^(?:\s*#[^\n]*\n)*\s*- (?:name:[^\n]+\n\s+)?uses:\s+tempoxyz/gh-actions/actions/secure-runner@2b8d302bd3c5ca64e0cb14ae4b1a9fa0a4069500[^\n]*`,
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
