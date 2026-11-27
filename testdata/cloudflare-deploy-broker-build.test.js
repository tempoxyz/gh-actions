const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

// tempoxyz/cloudflare-deploy-broker's test/build-workflow*.test.ts check the
// builder's contract with the broker at the revision the broker pins. These
// tests run the steps that fetch Git LFS objects and stage static assets.
const workflow = fs.readFileSync(
  path.join(__dirname, "../.github/workflows/cloudflare-deploy-broker-build.yml"), "utf8",
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

// The lines of a workflow_call input.
function input(name) {
  const start = lines.findIndex(line => line === `      ${name}:`);
  assert.notEqual(start, -1, `input ${name}`);
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("        ")) end++;
  return lines.slice(start + 1, end).map(line => line.trim());
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloudflare-deploy-broker-build-"));
}

const LFS_STEP = "Fetch Git LFS objects";
const ASSET_STEP = "Stage and hash static assets";
const hasGitLfs = spawnSync("git", ["lfs", "version"]).status === 0;
// GitHub-hosted runners ship git-lfs, so only a local run may skip.
const lfsTest = hasGitLfs || process.env.GITHUB_ACTIONS === "true"
  ? test
  : (name, fn) => test(name, { skip: "git-lfs is not installed" }, fn);

test("lfs and lfs-exclude are optional inputs that default off", () => {
  assert.deepEqual(input("lfs").filter(line => !line.startsWith("description:")), [
    "required: false", "type: boolean", "default: false",
  ]);
  assert.deepEqual(input("lfs-exclude").filter(line => !line.startsWith("description:")), [
    "required: false", "type: string", 'default: ""',
  ]);
});

test("LFS objects are fetched right after checkout, before any repository code runs", () => {
  const order = lines.filter(line => /^      - (?:name|uses): /.test(line)).map(line => line.trim());
  const checkout = order.findIndex(line => line.startsWith("- uses: actions/checkout@"));
  assert.equal(order[checkout + 1], `- name: ${LFS_STEP}`);
  assert.ok(checkout + 1 < order.indexOf("- name: Prepare dependencies"));
  const block = step(LFS_STEP).map(line => line.trim());
  assert.ok(block.includes("if: ${{ inputs.lfs || inputs.lfs-exclude != '' }}"));
  assert.ok(block.includes("TOKEN: ${{ github.token }}"));
  // The token and the filters reach git lfs pull only through its environment.
  assert.doesNotMatch(script(LFS_STEP), /git (?:-c|config)\b|lfs install/);
});

// A repository with three LFS files in a file:// remote, which git-lfs serves
// without a server, and a commit to check out.
let remote;
function lfsRemote() {
  if (remote) return remote;
  const dir = tempDir();
  const env = gitEnv(dir);
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "public/videos"), { recursive: true });
  fs.mkdirSync(path.join(source, "public/models"), { recursive: true });
  git(source, "init", "-q", "-b", "main");
  git(source, "lfs", "install", "--local");
  git(source, "lfs", "track", "*.mp4", "*.glb");
  fs.writeFileSync(path.join(source, "public/videos/intro.mp4"), "intro video\n");
  fs.writeFileSync(path.join(source, "public/teaser.mp4"), "teaser video\n");
  fs.writeFileSync(path.join(source, "public/models/coin.glb"), "coin model\n");
  fs.writeFileSync(path.join(source, "public/index.html"), "<!doctype html>\n");
  // .lfsconfig cannot narrow what the step fetches.
  fs.writeFileSync(path.join(source, ".lfsconfig"), "[lfs]\n\tfetchexclude = public/models/**\n");
  git(source, "add", "-A");
  git(source, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "fixture");
  const bare = path.join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", "-b", "main", bare);
  // The pre-push hook git lfs install wrote uploads the objects.
  git(source, "push", "-q", `file://${bare}`, "main");
  remote = { dir, bare };
  return remote;
}

// Git that reads no system or user configuration, so a developer's LFS
// filters cannot fetch what the step is supposed to.
function gitEnv(dir) {
  fs.writeFileSync(path.join(dir, "gitconfig"), "");
  return {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Checks the fixture out as actions/checkout does without lfs: pointers only.
function checkout(bare = lfsRemote().bare) {
  const dir = tempDir();
  const env = gitEnv(dir);
  const work = path.join(dir, "work");
  const clone = spawnSync("git", ["clone", "-q", `file://${bare}`, work], {
    env: { ...env, GIT_LFS_SKIP_SMUDGE: "1" }, encoding: "utf8",
  });
  assert.equal(clone.status, 0, clone.stderr);
  return { work, env };
}

function fetchLfs({ cwd, env, LFS = "true", LFS_EXCLUDE = "", PATH = process.env.PATH }) {
  const runner = fs.mkdtempSync(path.join(os.tmpdir(), "runner-temp-"));
  const result = spawnSync("bash", ["-c", script(LFS_STEP)], {
    cwd,
    encoding: "utf8",
    env: { ...env, PATH, RUNNER_TEMP: runner, LFS, LFS_EXCLUDE, TOKEN: "test-token" },
  });
  return { ...result, runnerTemp: fs.readdirSync(runner) };
}

const read = (work, file) => fs.readFileSync(path.join(work, file), "utf8");
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;

lfsTest("fetches every LFS object lfs-exclude does not match and leaves no credentials or hooks", () => {
  const { work, env } = checkout();
  assert.match(read(work, "public/models/coin.glb"), POINTER);
  const before = fs.readFileSync(path.join(work, ".git/config"), "utf8");
  const result = fetchLfs({ cwd: work, env, LFS_EXCLUDE: "public/videos/**\n\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fetched 2 Git LFS files/);
  assert.equal(read(work, "public/models/coin.glb"), "coin model\n");
  assert.equal(read(work, "public/teaser.mp4"), "teaser video\n");
  assert.match(read(work, "public/videos/intro.mp4"), POINTER);
  // git-lfs records only its own repository format version.
  const after = fs.readFileSync(path.join(work, ".git/config"), "utf8");
  assert.equal(after.replace(/\[lfs\]\n\trepositoryformatversion = 0\n/, ""), before);
  assert.doesNotMatch(after, /test-token|extraheader|filter|hooksPath/i);
  assert.deepEqual(fs.readdirSync(path.join(work, ".git/hooks")).filter(hook => !hook.endsWith(".sample")), []);
  assert.deepEqual(result.runnerTemp, []);
});

lfsTest("an lfs-exclude glob matches file names in any directory", () => {
  const { work, env } = checkout();
  const result = fetchLfs({ cwd: work, env, LFS_EXCLUDE: "*.mp4" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(work, "public/models/coin.glb"), "coin model\n");
  assert.match(read(work, "public/teaser.mp4"), POINTER);
  assert.match(read(work, "public/videos/intro.mp4"), POINTER);
});

lfsTest("fails when an LFS object cannot be fetched", () => {
  const { bare } = lfsRemote();
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lfs-remote-")), "remote.git");
  fs.cpSync(bare, missing, { recursive: true });
  const oid = createHash("sha256").update("coin model\n").digest("hex");
  fs.rmSync(path.join(missing, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid));
  const { work, env } = checkout(missing);
  const result = fetchLfs({ cwd: work, env, LFS_EXCLUDE: "public/videos/**" });
  assert.notEqual(result.status, 0);
  assert.match(read(work, "public/models/coin.glb"), POINTER);
});

lfsTest("fails when git lfs pull succeeds but leaves a pointer lfs-exclude does not match", () => {
  // Without the LFS filters configured, a real git lfs pull exits 0 without
  // checking anything out. This git does the same for every pull.
  const { work, env } = checkout();
  const bin = path.join(path.dirname(work), "bin");
  fs.mkdirSync(bin);
  const git = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "git"),
    `#!/bin/sh\nif [ "$1 $2" = "lfs pull" ]; then echo "Skipping object checkout" >&2; exit 0; fi\nexec ${git} "$@"\n`,
    { mode: 0o755 });
  const result = fetchLfs({ cwd: work, env, LFS_EXCLUDE: "public/videos/**", PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::public\/models\/coin\.glb was not fetched and is still a Git LFS pointer/);
  assert.match(result.stderr, /::error::public\/teaser\.mp4 was not fetched/);
  assert.doesNotMatch(result.stderr, /intro/);
});

for (const pattern of [
  "/public/videos/**",
  "public/../secrets/**",
  "./public/videos/**",
  "public/./videos",
  "public/videos/",
  "public/{videos,audio}/**",
  "public/videos/**,public/audio/**",
  "public/[a-z]*.mp4",
  "public videos/**",
  "!public/videos/**",
  "public/videos/**\n../outside",
]) {
  test(`refuses lfs-exclude pattern ${JSON.stringify(pattern)}`, () => {
    const dir = tempDir();
    const result = fetchLfs({ cwd: dir, env: gitEnv(dir), LFS_EXCLUDE: pattern });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /::error::lfs-exclude pattern .+ must be a path or glob inside the repository/);
  });
}

test("refuses lfs-exclude without lfs", () => {
  const dir = tempDir();
  const result = fetchLfs({ cwd: dir, env: gitEnv(dir), LFS: "false", LFS_EXCLUDE: "public/videos/**" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::lfs-exclude is set, but lfs is not true/);
});

test("fails clearly when git-lfs is missing", () => {
  const dir = tempDir();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // A git without the lfs subcommand, as on a runner without git-lfs.
  fs.writeFileSync(path.join(bin, "git"), '#!/bin/sh\nif [ "$1" = lfs ]; then echo "git: \'lfs\' is not a git command" >&2; exit 1; fi\nexit 0\n', { mode: 0o755 });
  const result = fetchLfs({ cwd: dir, env: gitEnv(dir), PATH: `${bin}:${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /::error::lfs is true, but git-lfs is not installed on this runner/);
});

// Runs the static asset step against a stand-in for Wrangler's
// unstable_readConfig that returns the configuration as written.
function stageAssets(files) {
  const dir = tempDir();
  const wrangler = path.join(dir, "node_modules/wrangler");
  fs.mkdirSync(wrangler, { recursive: true });
  fs.writeFileSync(path.join(wrangler, "package.json"), JSON.stringify({ name: "wrangler", type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(wrangler, "index.js"),
    'import { readFileSync } from "node:fs";\nexport const unstable_readConfig = ({ config }) => JSON.parse(readFileSync(config, "utf8"));\n');
  fs.writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({ assets: { directory: "public", binding: "ASSETS" } }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, "public", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof content === "function") content(file);
    else fs.writeFileSync(file, content);
  }
  const runner = path.join(dir, "runner");
  fs.mkdirSync(path.join(runner, "cloudflare-worker-artifact"), { recursive: true });
  const result = spawnSync("bash", ["-c", script(ASSET_STEP)], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      WORKING_DIRECTORY: ".",
      WRANGLER_CONFIG: "wrangler.json",
      WRANGLER_ENVIRONMENT: "",
      RUNNER_TEMP: runner,
      GITHUB_OUTPUT: path.join(dir, "output"),
    },
  });
  const manifestPath = path.join(runner, "cloudflare-worker-artifact/static-assets.json");
  const text = result.status === 0 ? fs.readFileSync(manifestPath, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, text, manifest: text ? JSON.parse(text) : undefined };
}

// The broker's static asset manifest schema accepts only media types of
// this form (src/shared/static-assets.ts).
const BROKER_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; charset=utf-8)?$/;

test("stages the media types tempo.com ships", () => {
  const expected = {
    "/AGENTS.md": "text/markdown; charset=utf-8",
    "/BUILD_ID": null,
    "/brand-kit.zip": "application/zip",
    "/cdn-cgi/_next_cache/build/index.cache": null,
    "/content/flags/LICENSE.md": "text/markdown; charset=utf-8",
    "/fonts/LiberationSans-Regular.ttf": "font/ttf",
    "/fonts/OFL.txt": "text/plain; charset=utf-8",
    "/fonts/inter.woff2": "font/woff2",
    "/images/hero.avif": "image/avif",
    "/images/logo.AVIF": "image/avif",
    "/models/coin.glb": "model/gltf-binary",
    "/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap": null,
    "/pdfjs/pdf.worker.min.mjs": "text/javascript; charset=utf-8",
    "/pdfjs/wasm/openjpeg.wasm": "application/wasm",
    "/robots.txt": "text/plain; charset=utf-8",
    "/site.webmanifest": "application/manifest+json",
    "/sitemap.xml": "application/xml",
    "/skills/agents/openai.yaml": "application/yaml",
    "/skills/agents/openai.yml": "application/yaml",
    "/static/dots.worker.ts": null,
    "/videos/intro.m3u8": "application/vnd.apple.mpegurl",
    "/videos/intro.mp4": "video/mp4",
    "/videos/intro.webm": "video/webm",
    "/whitepaper.pdf": "application/pdf",
  };
  const result = stageAssets(Object.fromEntries(Object.keys(expected).map(name => [name.slice(1), name])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.fromEntries(result.manifest.files.map(file => [file.path, file.mediaType])), expected);
  for (const { mediaType } of result.manifest.files) {
    if (mediaType !== null) assert.ok(BROKER_MEDIA_TYPE.test(mediaType) && mediaType.length <= 100, mediaType);
  }
  // The broker verifies the manifest's canonical encoding and code-unit order.
  assert.equal(result.text, `${JSON.stringify(result.manifest)}\n`);
});

test("refuses a Git LFS pointer as a static asset", () => {
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 230686720\n";
  const result = stageAssets({ "index.html": "<!doctype html>\n", "videos/intro.mp4": pointer });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /static asset is a Git LFS pointer, not the file it points to: videos\/intro\.mp4/);
  // A pointer with CRLF line endings is still a pointer.
  const crlf = stageAssets({ "videos/intro.mp4": pointer.replaceAll("\n", "\r\n") });
  assert.match(crlf.stderr, /Git LFS pointer, not the file it points to: videos\/intro\.mp4/);
});

test("stages a file that only mentions an LFS pointer", () => {
  const result = stageAssets({
    "docs/lfs.md": "Pointers start with:\nversion https://git-lfs.github.com/spec/v1\n",
    // git-lfs never reads a file of 1 KiB or more as a pointer.
    "data/large.txt": "version https://git-lfs.github.com/spec/v1\n" + "x".repeat(1024),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifest.files.map(file => file.path), ["/data/large.txt", "/docs/lfs.md"]);
});

// Hard links to one sparse file of zeros stand in for large assets without
// writing them to disk.
function largeAssets(count, size) {
  const files = {};
  let first;
  for (let index = 0; index < count; index++) {
    files[`chunk-${String(index).padStart(2, "0")}.bin`] = file => {
      if (first === undefined) {
        fs.writeFileSync(file, "");
        fs.truncateSync(file, size);
        first = file;
      } else {
        fs.linkSync(first, file);
      }
    };
  }
  return files;
}

test("stages more than 256 MiB of assets, up to 1 GiB", () => {
  const result = stageAssets(largeAssets(12, 24 * 1024 * 1024));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.manifest.files.reduce((total, file) => total + file.size, 0), 288 * 1024 * 1024);
});

test("refuses more than 1 GiB of assets", () => {
  const result = stageAssets(largeAssets(43, 24 * 1024 * 1024));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /static asset directory exceeds broker limits/);
});

test("keeps the 25 MiB per-file limit", () => {
  const result = stageAssets(largeAssets(1, 25 * 1024 * 1024 + 1));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /static asset has an invalid size: chunk-00\.bin/);
});
