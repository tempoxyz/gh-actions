const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function runMain(env) {
  return spawnSync(process.execPath, [path.join(__dirname, "main.cjs")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

const validInputs = {
  "INPUT_DEPLOYMENT-ID": "example-worker",
  "INPUT_ACCOUNT-ID": "a".repeat(32),
  "INPUT_WORKER-NAME": "example-worker",
  INPUT_HOST: "",
  GITHUB_RUN_ID: "1",
  GITHUB_SHA: "c".repeat(40),
};

test("runs on the runner's Node.js with the deploy action's broker client", () => {
  const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const main = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(action, /\nruns:\n  using: node24\n  main: main\.cjs\n$/);
  assert.ok(action.includes('default: "cf-deployer.tempoxyz.net"'));
  assert.ok(main.includes('operation: "delete-preview"'));
  assert.ok(main.includes('new URL("/v1/deploy", endpoint)'));
  assert.ok(main.includes("oidc(audience)"));
  // The broker derives the preview from the pull request; none is requested.
  assert.ok(!action.includes("preview-name:\n    description: \"Name"));
  assert.ok(!main.includes("previewName,"));
});

test("reads the runner's hyphenated input names before any request", () => {
  // Inputs are read first, so a missing commit is the first failure only when
  // every input was found. It also fails before any network request.
  const { GITHUB_SHA, ...withoutCommit } = validInputs;
  const result = runMain(withoutCommit);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GITHUB_SHA is missing or invalid/);
});

test("names the invalid input", () => {
  for (const [name, value] of [
    ["INPUT_DEPLOYMENT-ID", "Not Valid"],
    ["INPUT_ACCOUNT-ID", "not-an-account"],
    ["INPUT_WORKER-NAME", "-worker"],
  ]) {
    const result = runMain({ ...validInputs, [name]: value });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(`${name.slice(6).toLowerCase()} is missing or invalid`),
    );
  }
});
