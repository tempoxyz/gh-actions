const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
const workflowsDirectory = path.join(__dirname, "../../.github/workflows");
const wrapperPattern =
  /uses:\s+tempoxyz\/gh-actions\/actions\/harden-runner@46988f3d9ece5e4d6cc89b25a6e648616ee0f850/;
const secretExpression = String.raw`\$\{\{ secrets\.STEP_SECURITY_STS_PRD_URL \}\}`;

test("passes a caller-supplied STS URL to Harden Runner", () => {
  assert.match(manifest, /sts-url:\n\s+description:[^\n]+\n\s+required: true/);
  assert.match(
    manifest,
    /step-security\/harden-runner@e14015d583714f6e62063499dc959a02595150a1/,
  );
  assert.match(manifest, /sts-url: \$\{\{ inputs\.sts-url \}\}/);
  assert.match(manifest, /use-policy-store: true/);
  assert.doesNotMatch(manifest, /harden-runner-token|STEPSECURITY_API_KEY|GITHUB_ENV/);
});

test("every repository workflow job passes the organization STS URL to the wrapper", () => {
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
      `${filename} must use the authenticated Harden Runner wrapper`,
    );

    if (/^\s{2}workflow_call:/m.test(workflow) && wrapperPattern.test(workflow)) {
      assert.match(
        workflow,
        /secrets:\s*\n\s+STEP_SECURITY_STS_PRD_URL:\s*\n(?:\s+description:[^\n]+\n)?\s+required: true/,
        `${filename} must require STEP_SECURITY_STS_PRD_URL from reusable-workflow callers`,
      );
    }

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
      assert.match(
        jobBlock,
        /^    permissions:\n(?:      [^\n]+\n)*      id-token: write$/m,
        `${filename} must grant id-token: write for the STS exchange`,
      );
      if (usesProtectedWorkflow) {
        assert.match(
          jobBlock,
          new RegExp(
            String.raw`secrets:\s*\n\s+STEP_SECURITY_STS_PRD_URL:\s+${secretExpression}`,
          ),
          `${filename} must pass STEP_SECURITY_STS_PRD_URL to its reusable workflow`,
        );
        protectedJobs += 1;
      } else {
        const steps = jobBlock.split(/\n    steps:\s*\n/, 2)[1] || "";
        assert.match(
          steps,
          new RegExp(
            String.raw`^(?:\s*#[^\n]*\n)*\s*- (?:name:[^\n]+\n\s+)?uses:\s+tempoxyz/gh-actions/actions/harden-runner@46988f3d9ece5e4d6cc89b25a6e648616ee0f850[^\n]*\n\s+with:\s*\n\s+sts-url:\s+${secretExpression}`,
          ),
          `${filename} must pass STEP_SECURITY_STS_PRD_URL to the Harden Runner wrapper as the first step of every runnable job`,
        );
        protectedJobs += 1;
      }
    }
  }

  assert.ok(runnableJobs > 0, "expected at least one runnable workflow job");
  assert.equal(protectedJobs, runnableJobs);
});
