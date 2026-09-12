const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { install, commands, shellQuote } = require("./install-bash-hook.cjs");
const { detector } = require("./socket-guard.cjs");

function unix(file) {
  return process.platform === "win32"
    ? execFileSync("cygpath", ["-au", file], { encoding: "utf8" }).trim()
    : file;
}

function script(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

const bashExecutable = process.platform === "win32"
  ? execFileSync("bash", ["-c", 'cygpath -aw "$(type -P bash)"'], { encoding: "utf8" }).trim()
  : "bash";

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket test's "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "old shims");
  const tools = path.join(root, "tools v1");
  fs.mkdirSync(upstream);
  fs.mkdirSync(tools);
  const binary = path.join(root, "sfw");
  script(binary, `#!/bin/sh
printf 'socket\n' >> "$TRACE"
if [ "\${DENY_FIXTURE:-}" = true ]; then exit 42; fi
exec "$@"
`);
  const githubEnv = path.join(root, "github-env");
  fs.writeFileSync(githubEnv, "");
  // Keep process/tool discovery independent of any Socket setup on the CI host.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(path|bash_env|env|sfw_shim_dir|tempo_sfw_.*|_tempo_sfw_.*|actions_id_token_request_.*)$/i.test(key)));
  Object.assign(env, {
    PATH: `${unix(tools)}:/usr/bin:/bin`,
    RUNNER_TEMP: root,
    GITHUB_ENV: githubEnv,
    FIREWALL_PATH_BINARY: binary,
    SFW_SHIM_DIR: upstream,
    TRACE: unix(path.join(root, "trace")),
    ...extra,
  });
  // On Windows, Node needs the native PATH to locate cygpath/bash. The shell PATH
  // passed below remains POSIX, as it is in GitHub's Bash steps.
  const result = install(env);
  env.BASH_ENV = result.hook;
  const shims = `${unix(result.directory)}/bin`;
  const bash = (command, changes = {}) => spawnSync(bashExecutable, ["--noprofile", "--norc", "-c", command], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...env, ...changes },
    cwd: root,
  });
  const packageManager = (name, label, directory = tools, body = "") => {
    const file = path.join(directory, name);
    script(file, `#!/bin/bash\nprintf '%s\\n' ${shellQuote(label)}\nprintf '<%s>\\n' "$@"\n${body}\n`);
    return file;
  };
  return { root, upstream, tools, binary, githubEnv, env, shims, bash, packageManager, ...result };
}

function success(result) {
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function intercepted(f, expected = 1) {
  assert.equal(fs.readFileSync(path.join(f.root, "trace"), "utf8"), "socket\n".repeat(expected));
}

test("intercepts Cargo installed after activation and preserves arguments", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "new-cargo");
  const output = success(f.bash(`cargo install 'spaces here' '$(touch should-not-exist)' ''`));
  assert.equal(output, "new-cargo\n<install>\n<spaces here>\n<$(touch should-not-exist)>\n<>\n");
  assert.ok(!fs.existsSync(path.join(f.root, "should-not-exist")));
  intercepted(f);
});

test("repairs PATH after setup actions prepend a newer toolchain", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "old-cargo");
  success(f.bash("cargo --version"));
  const newer = path.join(f.root, "tools v2");
  f.packageManager("cargo", "new-cargo", newer);
  script(path.join(f.upstream, "cargo"), "#!/bin/sh\nexit 99\n");
  const output = success(f.bash("cargo --version", {
    PATH: `${unix(newer)}:${unix(f.upstream)}:${f.shims}:${f.env.PATH}`,
  }));
  assert.equal(output, "new-cargo\n<--version>\n");
  intercepted(f, 2);
});

test("resolves the selected binary at invocation time", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "old-cargo");
  const newer = path.join(f.root, "tools v2");
  f.packageManager("cargo", "new-cargo", newer);
  const output = success(f.bash(`PATH=${shellQuote(`${f.shims}:${unix(newer)}:${f.env.PATH}`)} cargo --version`));
  assert.equal(output, "new-cargo\n<--version>\n");
  intercepted(f);
});

test("does not rewrap when the hook directory has another path spelling", (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, "hook alias");
  fs.symlinkSync(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
  f.packageManager("cargo", "cargo");
  success(f.bash("cargo --version", { BASH_ENV: `${unix(alias)}/bash-hook.sh` }));
  intercepted(f);
});

test("discovers pnpm at the next step without losing Cargo interception", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  success(f.bash("cargo --version"));
  f.packageManager("pnpm", "pnpm");
  assert.match(success(f.bash("pnpm install --frozen-lockfile; cargo --version")), /pnpm\n<install>/);
  intercepted(f, 3);
});

test("does not advertise absent managers and removes stale shims", (t) => {
  const f = fixture(t);
  // A synthetic command makes absence deterministic on every runner image.
  const command = "tempo-fixture-pm";
  fs.appendFileSync(path.join(f.directory, "config.sh"), `_tempo_sfw_commands=(${command})\n`);
  assert.equal(f.bash(`command -v ${command}`).status, 1);
  const file = f.packageManager(command, "temporary");
  success(f.bash(`${command} --version`));
  fs.unlinkSync(file);
  const result = f.bash(`command -v ${command}`);
  assert.equal(result.status, 1);
  assert.ok(!fs.existsSync(path.join(f.directory, "bin", command)));
});

test("sources an existing BASH_ENV before repairing its PATH changes", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  const previous = path.join(f.root, "previous hook.sh");
  script(previous, `export FROM_PREVIOUS=preserved\nexport PATH=${shellQuote(f.env.PATH)}\n`);
  const installed = install({ ...f.env, BASH_ENV: previous });
  const output = success(f.bash('printf "%s\\n" "$FROM_PREVIOUS"; cargo --version', { BASH_ENV: installed.hook }));
  assert.equal(output, "preserved\ncargo\n<--version>\n");
  intercepted(f);
});

test("keeps startup options, arguments, cwd and traps intact", (t) => {
  const f = fixture(t);
  const output = success(f.bash(`set -u; set -- one 'two three'; trap ':' USR1; source "$BASH_ENV"; printf '%s\\n' "$1" "$2" "$PWD"; trap -p USR1`));
  assert.match(output, /^one\ntwo three\n/);
  assert.match(output, /trap -- ':' (?:SIG)?USR1/);
});

test("does not recursively wrap commands inside Socket's process tree", (t) => {
  const f = fixture(t);
  f.packageManager("pnpm", "pnpm");
  f.packageManager("cargo", "cargo", f.tools, `bash --noprofile --norc -c 'pnpm --version'`);
  const output = success(f.bash("cargo build"));
  assert.match(output, /cargo\n<build>\npnpm\n<--version>/);
  intercepted(f);
});

test("ordinary nested shells still activate interception", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  success(f.bash(`bash --noprofile --norc -c 'cargo --version'`));
  intercepted(f);
});

test("a prior startup file can start Bash without recursively sourcing itself", (t) => {
  const f = fixture(t);
  const previous = path.join(f.root, "nested.sh");
  script(previous, "bash --noprofile --norc -c ':'\n");
  const installed = install({ ...f.env, BASH_ENV: previous });
  f.packageManager("cargo", "cargo");
  success(f.bash("cargo --version", { BASH_ENV: installed.hook }));
  intercepted(f);
});

test("fails before the step when the prior startup file fails", (t) => {
  const f = fixture(t);
  const previous = path.join(f.root, "failure.sh");
  script(previous, "return 9\n");
  const installed = install({ ...f.env, BASH_ENV: previous });
  const result = f.bash("echo SHOULD_NOT_RUN", { BASH_ENV: installed.hook });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test("concurrent startup does not truncate active wrappers", async (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  const result = f.bash("for i in 1 2 3 4 5; do bash -c 'cargo --version' & done; wait");
  success(result);
  assert.doesNotMatch(result.stderr, /error|Text file busy/i);
  intercepted(f, 5);
});

test("repeated installation keeps the original startup hook without chaining", (t) => {
  const f = fixture(t);
  const again = install(f.env);
  assert.equal(again.hook, f.hook);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, "tempo-sfw-state.json"))).previous, "");
  f.packageManager("cargo", "cargo");
  success(f.bash("cargo --version"));
  intercepted(f);
});

test("fails before the step runs if Socket is missing", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.binary);
  const result = f.bash("echo SHOULD_NOT_RUN");
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  assert.match(result.stderr, /could not be activated/);
});

test("rejects a package-manager function that shadows interception", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  const previous = path.join(f.root, "functions.sh");
  script(previous, "cargo() { echo unwrapped; }\n");
  const installed = install({ ...f.env, BASH_ENV: previous });
  const result = f.bash("echo SHOULD_NOT_RUN", { BASH_ENV: installed.hook });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /alias or function takes precedence/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test("propagates policy denial without executing the package manager", (t) => {
  const f = fixture(t, { DENY_FIXTURE: "true" });
  f.packageManager("cargo", "SHOULD_NOT_RUN");
  const result = f.bash("cargo install harmless-fixture");
  assert.equal(result.status, 42);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
  intercepted(f);
});

test("preserves package-manager failures", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo", f.tools, "exit 23");
  assert.equal(f.bash("cargo build").status, 23);
  intercepted(f);
});

test("sets Cargo Git CLI compatibility only for Cargo and respects overrides", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo", f.tools, 'printf "git=%s\\n" "$CARGO_NET_GIT_FETCH_WITH_CLI"');
  assert.match(success(f.bash("cargo build")), /git=true/);
  assert.match(success(f.bash("cargo build", { CARGO_NET_GIT_FETCH_WITH_CLI: "false" })), /git=false/);
});

test("keeps the edition-specific command sets aligned with the pinned installer", () => {
  assert.deepEqual(commands(false), ["cargo", "npm", "pip", "pip3", "pnpm", "uv", "yarn"]);
  assert.deepEqual(commands(true, "darwin"), [...commands(false), "bundler", "gem", "nuget"]);
  assert.deepEqual(commands(true, "linux"), [...commands(true, "darwin"), "go"]);
});

test("manifest installs the hook using the nested action's verified binary", () => {
  const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8").replaceAll("\r\n", "\n");
  assert.match(manifest, /id: socket\n/);
  assert.match(manifest, /FIREWALL_PATH_BINARY: \$\{\{ steps.socket.outputs.firewall-path-binary \}\}/);
  assert.match(manifest, /run: node "\$GITHUB_ACTION_PATH\/install-bash-hook.cjs"/);
  assert.match(manifest, /shell: bash\n\s+run: test "\$\{TEMPO_SFW_BASH_READY:-\}" = "true"/);
});

const internalError = "Socket Firewall encountered an unexpected error";

test("detects the error signature across every possible chunk boundary", () => {
  const bytes = Buffer.from(`\0prefix\r\n${internalError}`);
  for (let split = 0; split <= bytes.length; split++) {
    const detects = detector();
    const first = detects(bytes.subarray(0, split));
    assert.ok(detects(bytes.subarray(split)) || first, `split ${split}`);
  }
  const detects = detector();
  assert.equal(detector()(Buffer.from("Socket report written successfully")), false);
  assert.ok([...bytes].map((byte) => detects(Buffer.from([byte]))).some(Boolean));
});

for (const stream of ["stdout", "stderr"]) {
  test(`fails all supported manager shims on zero-exit Socket errors in ${stream}`, (t) => {
    const f = fixture(t, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture", ACTIONS_ID_TOKEN_REQUEST_URL: "fixture" });
    const managers = commands(true);
    for (const manager of managers) f.packageManager(manager, "SHOULD_NOT_RUN");
    script(f.binary, `#!/bin/sh\nprintf '%s' '${internalError}' ${stream === "stderr" ? ">&2" : ""}\nexit 0\n`);
    for (const manager of managers) {
      const result = f.bash(`set -e; ${manager} --version; echo SHOULD_NOT_RUN`);
      assert.equal(result.status, 1, `${manager}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
      assert.match(result.stderr, /Socket reported an internal failure/);
    }
  });
}

test("preserves nonzero Socket errors including timeout exits", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "SHOULD_NOT_RUN");
  for (const code of [23, 42, 124]) {
    script(f.binary, `#!/bin/sh\nprintf '%s\\n' '${internalError}' >&2\nexit ${code}\n`);
    assert.equal(f.bash("cargo fetch --locked").status, code);
  }
});

test("preserves JSON stdout, separate stderr, stdin and large output", (t) => {
  const f = fixture(t);
  script(path.join(f.tools, "cargo"), `#!/bin/sh\ncat\nprintf 'diagnostic\\n' >&2\n`);
  const input = JSON.stringify({ data: "abc".repeat(100000) });
  const result = spawnSync(bashExecutable, ["--noprofile", "--norc", "-c", "cargo metadata"], {
    env: f.env, cwd: f.root, encoding: "utf8", input, timeout: 15000, maxBuffer: 2000000,
  });
  assert.equal(success(result), input);
  assert.equal(result.stderr, "diagnostic\n");
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(input));
});

test("independent guards do not share error state", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "cargo");
  script(f.binary, `#!/bin/sh\nif [ "$2" = fail ]; then printf '%s' '${internalError}' >&2; exit 0; fi\nexec "$@"\n`);
  const result = f.bash('cargo fail >failed.out 2>failed.err & failed=$!; cargo ok >ok.out 2>ok.err & ok=$!; wait "$failed"; failed_status=$?; wait "$ok"; ok_status=$?; printf "%s %s\\n" "$failed_status" "$ok_status"');
  assert.equal(success(result), "1 0\n");
  assert.equal(fs.readFileSync(path.join(f.root, "ok.err"), "utf8"), "");
});

test("a missing guard fails instead of running the manager unguarded", (t) => {
  const f = fixture(t);
  f.packageManager("cargo", "SHOULD_NOT_RUN");
  fs.unlinkSync(path.join(f.directory, "socket-guard.cjs"));
  const result = f.bash("cargo --version");
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_RUN/);
});

test("guard initialization and spawn failures are nonzero", () => {
  for (const args of [[], ["/nonexistent-tempo-bash", "/nonexistent-sfw", "cargo"]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "socket-guard.cjs"), ...args], { encoding: "utf8", timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Socket guard could not/);
  }
});

test("POSIX cancellation reaches Socket and its process group", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const f = fixture(t);
  script(f.binary, `#!/bin/sh\ntrap 'exit 0' TERM\nsleep 60 &\nprintf 'ready\\n'\nwait\n`);
  const guard = spawn(process.execPath, [path.join(__dirname, "socket-guard.cjs"), "bash", f.binary, "cargo"], {
    env: { ...process.env, BASH_ENV: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (guard.exitCode === null) guard.kill("SIGKILL"); });
  const closed = new Promise((resolve, reject) => { guard.once("error", reject); guard.once("close", resolve); });
  // The child is ready only after the supervisor has installed its handlers.
  await new Promise((resolve) => guard.stdout.once("data", resolve));
  guard.kill("SIGTERM");
  assert.equal(await closed, 143);
});
