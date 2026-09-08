const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { hardenRunnerEnv } = require("./run.cjs");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/harden-runner@a4827438adadd5a9083f0400950232177b0c7b6b/;
const rustWorkflows = new Set(["rust-lint.yml", "rust-deny.yml"]);
const unauthenticatedPattern =
  /uses:\s+tempoxyz\/gh-actions\/vendor\/step-security\/harden-runner@3a9189ec4c3d19f2863398822c73edd06b33fba3/;

test("Rust lint workflows cannot grant OIDC or accept caller secrets", () => {
  for (const filename of rustWorkflows) {
    const workflow = fs.readFileSync(path.join(workflowsDirectory, filename), "utf8");
    assert.match(workflow, /^permissions: \{\}$/m);
    assert.doesNotMatch(workflow, /id-token:|secrets[.:]|: write\b/);
    assert.doesNotMatch(workflow, /actions\/(?:harden-runner|step-security-sts)@/);

    const jobs = workflow.split(/^jobs:\s*\n/m)[1];
    assert.ok(jobs, `${filename} must declare jobs`);
    const jobBlocks = jobs.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    assert.ok(jobBlocks.length > 0);
    for (const job of jobBlocks) {
      assert.match(job, /^    permissions:(?: \{\}|\n      contents: read)$/m,
        `${filename} must explicitly restrict every job, including nested calls`);
      if (!/^    runs-on:/m.test(job)) continue;
      assert.match(job, unauthenticatedPattern);
      assert.match(job, /^          egress-policy: block$/m);
      assert.match(job, /use-policy-store: false\n          api-key: ""\n          policy: ""\n          token: ""/);
      const allowed = job.match(/^          allowed-endpoints: (?:>-\n((?:            [^\n]+\n)+)|([^\n]+))/m);
      assert.ok(allowed, "every job needs a nonempty, literal allowlist");
      const endpoints = (allowed[1] || allowed[2]).trim().split(/\s+/);
      assert.equal(new Set(endpoints).size, endpoints.length);
      const reviewedEndpoints = new Set([
        "github.com:443",
        "api.github.com:443",
        "codeload.github.com:443",
        "release-assets.githubusercontent.com:443",
        "static.rust-lang.org:443",
        "index.crates.io:443",
        "static.crates.io:443",
      ]);
      for (const endpoint of endpoints) {
        assert.ok(reviewedEndpoints.has(endpoint), `unreviewed endpoint: ${endpoint}`);
      }
      const jobName = job.match(/^  ([A-Za-z0-9_-]+):/)[1];
      if (jobName === "clippy" || jobName === "deny") {
        assert.ok(endpoints.includes("index.crates.io:443"));
        assert.ok(endpoints.includes("static.crates.io:443"));
      } else {
        assert.ok(!endpoints.some((endpoint) => endpoint.endsWith("crates.io:443")));
      }
      if (jobName === "lint-success") {
        assert.deepEqual(endpoints, ["api.github.com:443"]);
      }
    }
  }
});

test("network smoke tests exercise both reusable Rust workflows without OIDC", () => {
  const workflow = fs.readFileSync(path.join(workflowsDirectory, "test.yml"), "utf8");
  for (const jobName of ["rust-lint-network", "rust-deny-network"]) {
    const job = workflow.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/)
      .find((block) => block.startsWith(`  ${jobName}:`));
    assert.ok(job, `missing ${jobName}`);
    assert.match(job, /working-directory: tests\/fixtures\/rust-lint/);
    assert.match(job, /permissions:\n      contents: read/);
    assert.doesNotMatch(job, /run-(?:clippy|fmt|typos|deny): false|id-token:/);
  }
  const wrapper = fs.readFileSync(path.join(workflowsDirectory, "rust-deny.yml"), "utf8");
  assert.match(wrapper, /working-directory: \$\{\{ inputs.working-directory \}\}/);
});

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

test("every repository workflow job uses its required Harden Runner mode", () => {
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
      /uses:\s+step-security\/harden-runner@/,
      `${filename} must use a pinned first-party Harden Runner path`,
    );
    assert.doesNotMatch(workflow, /STEP_SECURITY_STS_(?:DEV|PRD)_URL/);

    const jobBlocks = workflow.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    for (const jobBlock of jobBlocks) {
      const runsOnRunner = /^    runs-on:/m.test(jobBlock);
      const reusableWorkflow = jobBlock.match(
        /uses:\s+\.\/\.github\/workflows\/([^\s]+)/,
      );
      const usesRustWorkflow = reusableWorkflow && rustWorkflows.has(reusableWorkflow[1]);
      const usesProtectedWorkflow = usesRustWorkflow ||
        reusableWorkflow &&
        wrapperPattern.test(
          fs.readFileSync(
            path.join(workflowsDirectory, reusableWorkflow[1]),
            "utf8",
          ),
        );
      if (!runsOnRunner && !reusableWorkflow) continue;

      runnableJobs += 1;
      if (rustWorkflows.has(filename) || usesRustWorkflow) {
        assert.doesNotMatch(jobBlock, /id-token:|: write\b/);
      } else {
        assert.match(
          jobBlock,
          /^    permissions:\n(?:      [^\n]+\n)*      id-token: write$/m,
          `${filename} must grant id-token: write for the STS exchange`,
        );
      }
      if (usesProtectedWorkflow) {
        protectedJobs += 1;
      } else {
        const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1] || "";
        assert.match(
          steps,
          new RegExp(
            String.raw`^(?:\s*#[^\n]*\n)*\s*- (?:name:[^\n]+\n\s+)?${
              rustWorkflows.has(filename) ? unauthenticatedPattern.source : wrapperPattern.source
            }[^\n]*`,
          ),
          `${filename} must harden the runner in the expected mode before other steps`,
        );
        protectedJobs += 1;
      }
    }
  }

  assert.ok(runnableJobs > 0, "expected at least one runnable workflow job");
  assert.equal(protectedJobs, runnableJobs);
});
