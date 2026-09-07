const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/harden-runner@904d020d877cc74df9ba1524d0e4e53e9c2088cb/;

test("mints the credential in an earlier pinned pre entrypoint", () => {
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/actions\/harden-runner-token@0947059453e8f500259563c79801f95e996379be/,
  );
  assert.ok(
    manifest.indexOf("actions/harden-runner-token@") <
      manifest.indexOf("step-security/harden-runner@"),
    "token pre entrypoint must be referenced before Harden Runner",
  );
});

test("passes and then clears the minted credential", () => {
  assert.match(
    manifest,
    /step-security\/harden-runner@e14015d583714f6e62063499dc959a02595150a1/,
  );
  assert.match(
    manifest,
    /api-key: \$\{\{ env\.STEPSECURITY_API_KEY \}\}/,
  );
  assert.match(manifest, /use-policy-store: true/);
  assert.match(
    manifest,
    /echo "STEPSECURITY_API_KEY=" >> "\$GITHUB_ENV"/,
  );
});

test("every repository workflow job is protected by the OIDC wrapper", () => {
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
      `${filename} must use the OIDC-authenticated Harden Runner wrapper`,
    );

    const jobBlocks = workflow.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    for (const jobBlock of jobBlocks) {
      const runsOnRunner = /^    runs-on:/m.test(jobBlock);
      const reusableWorkflow = jobBlock.match(
        /uses:\s+\.\/\.github\/workflows\/([^\s]+)/,
      );
      const usesProtectedWorkflow =
        reusableWorkflow &&
        wrapperPattern.test(
          fs.readFileSync(
            path.join(workflowsDirectory, reusableWorkflow[1]),
            "utf8",
          ),
        );
      if (!runsOnRunner && !reusableWorkflow) continue;

      runnableJobs += 1;
      if (usesProtectedWorkflow) {
        protectedJobs += 1;
      } else {
        const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1] || "";
        assert.match(
          steps,
          /^\s*- (?:name:[^\n]+\n\s+)?uses:\s+tempoxyz\/gh-actions\/actions\/harden-runner@904d020d877cc74df9ba1524d0e4e53e9c2088cb/,
          `${filename} must use the OIDC-authenticated Harden Runner wrapper as the first step of every runnable job`,
        );
        protectedJobs += 1;
      }

      const jobHeader = jobBlock.split(/\n    steps:\s*\n/, 1)[0];
      assert.match(
        jobHeader,
        /^      id-token: write$/m,
        `${filename} must grant id-token: write to every job using the wrapper`,
      );
    }
  }

  assert.ok(runnableJobs > 0, "expected at least one runnable workflow job");
  assert.equal(protectedJobs, runnableJobs);
});
