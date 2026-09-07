const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const actionPath = path.join(__dirname, "action.yml");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function setupFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "create-pr-action-"));
  const repository = path.join(directory, "repo");
  const bin = path.join(directory, "bin");
  const runnerTemp = path.join(directory, "runner-temp");
  await Promise.all([
    mkdir(repository),
    mkdir(bin),
    mkdir(runnerTemp),
  ]);

  run("git", ["init", "-q"], { cwd: repository });
  run("git", ["config", "user.name", "Test"], { cwd: repository });
  run("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "base\n");
  run("git", ["add", "README.md"], { cwd: repository });
  run("git", ["commit", "-qm", "base"], { cwd: repository });

  const ghPath = path.join(bin, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "api repos/test/repo/git/ref/heads/test-branch") exit 1 ;;
  "api graphql"*) echo "0123456789abcdef" ;;
  "pr list"*) ;;
  "pr create"*) echo "https://github.com/test/repo/pull/1" ;;
esac
`,
  );
  await chmod(ghPath, 0o755);

  const action = await readFile(actionPath, "utf8");
  const marker = "      run: |\n";
  const actionScript = action.slice(action.indexOf(marker) + marker.length)
    .split("\n")
    .map((line) => line.startsWith("        ") ? line.slice(8) : line)
    .join("\n");
  // GitHub's Ubuntu runners use Bash 5. Provide the one missing builtin when
  // running this test on macOS's Bash 3.2.
  const script = `
if ! type mapfile >/dev/null 2>&1; then
  mapfile() {
    shift
    local variable="$1" line
    eval "$variable=()"
    while IFS= read -r line; do
      eval "$variable+=(\"\$line\")"
    done
  }
fi
${actionScript}`;

  const env = {
    ...process.env,
    ADD_PATHS: ".",
    BASE: "main",
    BODY: "Test body",
    BRANCH: "test-branch",
    COMMIT_MESSAGE: "test commit",
    GH_REPO: "test/repo",
    GH_TOKEN: "test-token",
    GITHUB_OUTPUT: path.join(directory, "github-output"),
    LABELS: "test-label",
    PATH: `${bin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    TITLE: "Test PR",
  };

  return { directory, env, repository, runnerTemp, script };
}

test("commits regular files from their staged blobs", async (t) => {
  const fixture = await setupFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await writeFile(path.join(fixture.repository, "generated.txt"), "generated\n");
  const result = spawnSync("bash", ["-c", fixture.script], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: fixture.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const request = JSON.parse(
    await readFile(path.join(fixture.runnerTemp, "create-commit.json"), "utf8"),
  );
  const additions = request.variables.input.fileChanges.additions;
  const generated = additions.find(({ path: filePath }) => filePath === "generated.txt");
  assert.equal(Buffer.from(generated.contents, "base64").toString(), "generated\n");
});

test("rejects symlinks without reading their targets", async (t) => {
  const fixture = await setupFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const secret = path.join(fixture.directory, "secret");
  await writeFile(secret, "runner-secret\n");
  await symlink(secret, path.join(fixture.repository, "leak"));

  const result = spawnSync("bash", ["-c", fixture.script], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: fixture.env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported git mode '120000' for 'leak'/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /runner-secret/);
});
