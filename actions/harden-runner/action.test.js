const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/harden-runner@904d020d877cc74df9ba1524d0e4e53e9c2088cb/;

test("mints a policy-store credential with the pinned GitHub Script action", () => {
  assert.match(
    manifest,
    /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/,
  );
  assert.match(manifest, /mintStepSecurityToken/);
});

test("passes the minted credential to the pinned Harden Runner action", () => {
  assert.match(
    manifest,
    /step-security\/harden-runner@e14015d583714f6e62063499dc959a02595150a1/,
  );
  assert.match(
    manifest,
    /api-key: \$\{\{ steps\.stepsecurity-token\.outputs\.token \}\}/,
  );
  assert.match(manifest, /use-policy-store: true/);
});

test("repository workflows use the OIDC wrapper with id-token permission", () => {
  let wrapperJobs = 0;

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
      if (!wrapperPattern.test(jobBlock) && !usesProtectedWorkflow) continue;

      wrapperJobs += 1;
      const jobHeader = jobBlock.split(/\n    steps:\s*\n/, 1)[0];
      assert.match(
        jobHeader,
        /^      id-token: write$/m,
        `${filename} must grant id-token: write to every job using the wrapper`,
      );
    }
  }

  assert.ok(wrapperJobs > 0, "expected at least one workflow to use the wrapper");
});
