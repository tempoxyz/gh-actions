const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/reproducible-eif-verify.yml"), "utf8",
);
const lines = workflow.split("\n");

// The lines of a step, from its "- name:" line to the next step or job.
function step(name) {
  const start = lines.findIndex(line => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `step ${name}`);
  const indent = lines[start].indexOf("-");
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)) end++;
  return lines.slice(start, end);
}

// A step's run script, dedented.
function script(name) {
  const block = step(name);
  const start = block.findIndex(line => line.trim() === "run: |");
  assert.notEqual(start, -1, `run script of ${name}`);
  const body = block.slice(start + 1);
  const indent = body.find(line => line.trim()).search(/\S/);
  return body.map(line => line.slice(indent)).join("\n");
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reproducible-eif-"));
}

function outputs(file) {
  return Object.fromEntries(fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

function resolve(env) {
  const dir = tempDir();
  const git = args => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "t"]);
  fs.writeFileSync(path.join(dir, "output"), "");
  const result = spawnSync("bash", ["-c", script("Validate and resolve inputs")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: path.join(dir, "output"),
      RECIPE_SHA: "a".repeat(40),
      RECIPE_PATHS: ".dockerignore\nbuild.sh",
      BUILD_SCRIPT: "build.sh",
      EIF_BUILDER_IMAGE: "ghcr.io/example/nitro-cli@sha256:" + "0".repeat(64),
      BUILD_INPUT_URL: "",
      BUILD_INPUT_SHA256: "",
      BUILD_TARGET: "",
      ARTIFACT_NAME: "reproducible-eif-verification",
      ...env,
    },
  });
  return { ...result, outputs: result.status === 0 ? outputs(path.join(dir, "output")) : {} };
}

test("artifact names stay the same without a build target", () => {
  const result = resolve({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.artifact_prefix, "reproducible-eif-verification");
});

test("artifact names carry the build target", () => {
  const a = resolve({ ARTIFACT_NAME: "eif-verify", BUILD_TARGET: "mainnet-test" });
  const b = resolve({ ARTIFACT_NAME: "eif-verify", BUILD_TARGET: "testnet_1.2" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.outputs.artifact_prefix, "eif-verify-mainnet-test");
  assert.equal(b.outputs.artifact_prefix, "eif-verify-testnet_1.2");
});

test("each call gets its own call ID", () => {
  const [a, b] = [resolve({}), resolve({})];
  assert.match(a.outputs.call_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.outputs.call_id, b.outputs.call_id);
});

for (const target of ["a/b", "a b", "-a", "a:b", "a\nb", "a*"]) {
  test(`refuses build target ${JSON.stringify(target)}`, () => {
    const result = resolve({ BUILD_TARGET: target });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /build-target may contain only/);
  });
}

test("every artifact name is built from the resolved prefix", () => {
  const names = lines.filter(line => /^\s+name: \$\{\{/.test(line)).map(line => line.trim());
  assert.deepEqual(names, [
    "name: ${{ needs.resolve.outputs.artifact_prefix }}-${{ matrix.backend }}",
    "name: ${{ needs.resolve.outputs.artifact_prefix }}-depot",
    "name: ${{ needs.resolve.outputs.artifact_prefix }}-docker",
    "name: ${{ needs.resolve.outputs.artifact_prefix }}",
  ]);
  assert.ok(step("Upload EIF").some(line => line.trim() === "${{ runner.temp }}/eif-output/call-id"));
});

function tokenLifetime(expiresAt) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "output"), "");
  const result = spawnSync("bash", ["-c", script("Limit the build to the token lifetime")], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: path.join(dir, "output"), EXPIRES_AT: expiresAt },
  });
  return { ...result, outputs: result.status === 0 ? outputs(path.join(dir, "output")) : {} };
}

test("the build step stops before the dependency token expires", () => {
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  for (const expiresAt of [inAnHour, inAnHour.replace(/\.\d+Z$/, "Z")]) {
    const result = tokenLifetime(expiresAt);
    assert.equal(result.status, 0, result.stderr);
    assert.ok([58, 59].includes(Number(result.outputs.minutes)), result.outputs.minutes);
  }
  const soon = tokenLifetime(new Date(Date.now() + 90_000).toISOString());
  assert.notEqual(soon.status, 0);
  assert.match(soon.stderr, /too soon to build/);

  assert.ok(step("Build EIF").some(line => line.trim() ===
    "timeout-minutes: ${{ fromJSON(steps.token_lifetime.outputs.minutes || '90') }}"));
  // No ttl: the token gets the longest lifetime the policy allows, which expires-at reports.
  assert.ok(!step("Authorize private dependency fetch").some(line => line.trim().startsWith("ttl:")));
  // Minted right before the build: nothing runs between the token and the build script.
  const order = lines.filter(line => /^\s+- name: /.test(line)).map(line => line.trim());
  const at = order.indexOf("- name: Authorize private dependency fetch");
  assert.deepEqual(order.slice(at, at + 3), [
    "- name: Authorize private dependency fetch",
    "- name: Limit the build to the token lifetime",
    "- name: Build EIF",
  ]);
});

function compare(callIds) {
  const temp = tempDir();
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const pcr = "ab".repeat(48);
  const report = JSON.stringify({
    CheckCRC: true,
    IsSigned: false,
    Measurements: { HashAlgorithm: "Sha384 { ... }", PCR0: pcr, PCR1: pcr, PCR2: pcr },
  });
  fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho '" + report + "'\n", { mode: 0o755 });
  for (const [backend, callId] of Object.entries(callIds)) {
    const dir = path.join(temp, "eifs", backend);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enclave.eif"), "eif");
    fs.writeFileSync(path.join(dir, "call-id"), callId + "\n");
  }
  fs.writeFileSync(path.join(temp, "output"), "");
  const result = spawnSync("bash", ["-c", script("Measure EIFs and compare PCRs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: path.join(temp, "output"),
      GITHUB_STEP_SUMMARY: path.join(temp, "summary"),
      SOURCE_SHA: "a".repeat(40),
      RECIPE_SHA: "b".repeat(40),
      RECIPE_PATHS: ".dockerignore\nbuild.sh",
      BUILD_SCRIPT: "build.sh",
      BUILD_TARGET: "mainnet-test",
      JOB_CONTEXT: JSON.stringify({ workflow_sha: "c".repeat(40) }),
      SOURCE_DATE_EPOCH: "1700000000",
      EIF_BUILDER_IMAGE: "ghcr.io/example/nitro-cli@sha256:" + "0".repeat(64),
      BUILD_INPUT_URL: "",
      BUILD_INPUT_SHA256: "",
      CALL_ID: "this-call",
      BUILD_RESULT: "success",
    },
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(temp, "eif-verification", "manifest.json"), "utf8"));
  return { ...result, manifest };
}

test("the comparison measures this call's EIFs", () => {
  const result = compare({ depot: "this-call", docker: "this-call" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.manifest.comparison_result, "success");
  assert.equal(result.manifest.call_id, "this-call");
  assert.equal(result.manifest.build_target, "mainnet-test");
});

test("the comparison refuses another call's EIF", () => {
  const result = compare({ depot: "this-call", docker: "other-call" });
  assert.notEqual(result.status, 0);
  assert.equal(result.manifest.comparison_result, "failed");
  assert.match(result.manifest.failure, /^docker: EIF artifact was uploaded by another call/);
});
