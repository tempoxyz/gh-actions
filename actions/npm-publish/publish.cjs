#!/usr/bin/env node
// Packs and publishes npm packages with npm trusted publishing (GitHub OIDC).
//
//   node publish.cjs pack      pack the unpublished packages into PACK_DIRECTORY and write plan.json
//   node publish.cjs publish   publish the tarballs listed in PACK_DIRECTORY/plan.json, in order
//
// Inputs come from environment variables set by action.yml, so workflow expressions never reach a
// shell. Packing runs the repository's pack scripts; publishing runs no repository code: it checks
// each tarball's manifest against the plan and hands the tarball to npm.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REGISTRY = "https://registry.npmjs.org";
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const TAG_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MIN_NPM = [11, 5, 1];

function splitList(value) {
  return String(value || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

function parseBool(name, value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false" || v === "") return false;
  throw new Error(name + " must be 'true' or 'false', got '" + value + "'");
}

function run(cmd, args, { cwd, capture = true, env = process.env } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return res;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function detectPackageManager(root, requested) {
  if (requested && requested !== "auto") {
    if (!["npm", "pnpm", "bun"].includes(requested)) throw new Error("package-manager must be auto, npm, pnpm or bun");
    return requested;
  }
  if (fs.existsSync(path.join(root, "pnpm-workspace.yaml")) || fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

// Directories of the workspace's packages (the root included), found with the package manager.
function discoverPackages(root, pm) {
  if (pm === "pnpm") {
    const res = run("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { cwd: root });
    if (res.status !== 0) throw new Error("pnpm ls failed: " + res.stderr);
    return JSON.parse(res.stdout).map((p) => p.path);
  }
  const rootPkg = readJson(path.join(root, "package.json"));
  if (!rootPkg.workspaces) return [root];
  const res = run("npm", ["query", ".workspace", "--json"], { cwd: root });
  if (res.status !== 0) throw new Error("npm query failed: " + res.stderr);
  return [root, ...JSON.parse(res.stdout).map((p) => path.resolve(root, p.location || p.path))];
}

// Orders packages so each comes after the selected packages it depends on at run time
// (dependencies, optionalDependencies, peerDependencies). devDependencies are not installed by
// consumers and do not constrain the order.
function orderPackages(pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const deps = new Map();
  for (const p of pkgs) {
    const internal = new Set();
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(p.manifest[field] || {})) if (byName.has(dep) && dep !== p.name) internal.add(dep);
    }
    deps.set(p.name, internal);
  }
  const order = [];
  while (deps.size) {
    const ready = [...deps].filter(([, d]) => d.size === 0).map(([n]) => n).sort();
    if (!ready.length) throw new Error("dependency cycle between: " + [...deps.keys()].sort().join(", "));
    for (const n of ready) {
      order.push(byName.get(n));
      deps.delete(n);
      for (const d of deps.values()) d.delete(n);
    }
  }
  return order;
}

function selectPackages(root, dirs) {
  const seen = new Set();
  const pkgs = [];
  for (const dir of dirs) {
    const abs = path.resolve(root, dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const file = path.join(abs, "package.json");
    if (!fs.existsSync(file)) throw new Error("no package.json in " + dir);
    const manifest = readJson(file);
    if (manifest.private) continue;
    if (!NAME_RE.test(manifest.name || "")) throw new Error("invalid package name in " + file + ": " + manifest.name);
    if (!VERSION_RE.test(manifest.version || "")) throw new Error("invalid version in " + file + ": " + manifest.version);
    pkgs.push({ name: manifest.name, version: manifest.version, dir: abs, manifest });
  }
  return orderPackages(pkgs);
}

async function publishedVersions(name, fetchImpl = fetch) {
  const url = REGISTRY + "/" + name.replace("/", "%2f");
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Accept: "application/vnd.npm.install-v1+json" } });
    } catch (err) {
      if (attempt >= 5) throw new Error("fetching " + url + ": " + err.message);
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 404) return new Set();
    if (res.ok) return new Set(Object.keys((await res.json()).versions || {}));
    if (attempt >= 5) throw new Error("fetching " + url + ": HTTP " + res.status);
    await sleep(2000 * attempt);
  }
}

// The section of CHANGELOG.md for this version (Changesets writes "## <version>"), for release notes.
function changelogSection(dir, version) {
  const file = path.join(dir, "CHANGELOG.md");
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().replace(/^v/, "") === version);
  if (start < 0) return "";
  let end = lines.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

function packOne(pkg, pm, dest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "npm-pack-"));
  const args =
    pm === "pnpm" ? ["pack", "--pack-destination", tmp]
    : pm === "bun" ? ["pm", "pack", "--destination", tmp]
    : ["pack", "--pack-destination", tmp];
  const res = run(pm, args, { cwd: pkg.dir, capture: false });
  if (res.status !== 0) throw new Error(pm + " pack failed for " + pkg.name);
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
  if (files.length !== 1) throw new Error(pm + " pack for " + pkg.name + " produced " + files.length + " tarballs");
  const file = pkg.name.replace(/^@/, "").replace("/", "-") + "-" + pkg.version + ".tgz";
  fs.copyFileSync(path.join(tmp, files[0]), path.join(dest, file));
  fs.rmSync(tmp, { recursive: true, force: true });
  return file;
}

function tarballManifest(file) {
  const res = run("tar", ["-xOzf", file, "package/package.json"]);
  if (res.status !== 0) throw new Error("cannot read package/package.json from " + file + ": " + res.stderr);
  return JSON.parse(res.stdout);
}

// A tarball must hold exactly the planned package and version, with no workspace or local
// dependency specifiers left that npm would publish verbatim.
function checkTarball(file, entry) {
  const m = tarballManifest(file);
  if (m.name !== entry.name || m.version !== entry.version) {
    throw new Error(path.basename(file) + " holds " + m.name + "@" + m.version + ", not " + entry.name + "@" + entry.version);
  }
  if (m.private) throw new Error(entry.name + " is private");
  const bad = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(m[field] || {})) {
      if (/^(workspace:|link:|file:|portal:|catalog:)/.test(String(spec))) bad.push(field + "." + dep + " = " + spec);
    }
  }
  if (bad.length) throw new Error(entry.name + "@" + entry.version + " would publish local dependency specifiers: " + bad.join(", "));
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function npmVersion() {
  const res = run("npm", ["--version"]);
  if (res.status !== 0) throw new Error("npm is not installed");
  return res.stdout.trim();
}

function supportsTrustedPublishing(version) {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) && compareVersions(parts, MIN_NPM) >= 0;
}

// A stored registry token would make npm skip the OIDC exchange, so none may be configured.
function storedTokenFiles(files) {
  return files.filter((f) => {
    if (!f || !fs.existsSync(f)) return false;
    return fs.readFileSync(f, "utf8").split("\n").some((line) => /_(authToken|auth|password)\s*=\s*(?!\$\{)\S/.test(line.replace(/^\s*[#;].*$/, "")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = "EOF_" + Math.random().toString(36).slice(2);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, name + "<<" + delimiter + "\n" + value + "\n" + delimiter + "\n");
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

async function pack() {
  const root = path.resolve(process.env.INPUT_WORKING_DIRECTORY || ".");
  const dest = path.resolve(process.env.PACK_DIRECTORY);
  const skipPublished = parseBool("skip-published", process.env.INPUT_SKIP_PUBLISHED);
  const dryRun = parseBool("dry-run", process.env.INPUT_DRY_RUN);
  const pm = detectPackageManager(root, process.env.INPUT_PACKAGE_MANAGER);
  const dirs = splitList(process.env.INPUT_PACKAGES);
  const pkgs = selectPackages(root, dirs.length ? dirs : discoverPackages(root, pm));
  fs.mkdirSync(dest, { recursive: true });

  const plan = [];
  const skipped = [];
  for (const pkg of pkgs) {
    if (skipPublished && !dryRun && (await publishedVersions(pkg.name)).has(pkg.version)) {
      skipped.push(pkg.name + "@" + pkg.version);
      continue;
    }
    const file = packOne(pkg, pm, dest);
    const entry = { name: pkg.name, version: pkg.version, file, notes: changelogSection(pkg.dir, pkg.version) };
    checkTarball(path.join(dest, file), entry);
    plan.push(entry);
  }
  fs.writeFileSync(path.join(dest, "plan.json"), JSON.stringify({ packages: plan, workspaceSize: pkgs.length }, null, 2));
  console.log("To publish: " + (plan.map((p) => p.name + "@" + p.version).join(" ") || "(nothing)"));
  if (skipped.length) console.log("Already on npm, skipped: " + skipped.join(" "));
  setOutput("packages", JSON.stringify(plan.map(({ name, version }) => ({ name, version }))));
  setOutput("skipped", skipped.join(" "));
  summary("### npm publish plan\n\n" + (plan.length ? plan.map((p, i) => (i + 1) + ". \`" + p.name + "@" + p.version + "\`").join("\n") : "Nothing to publish.") +
    (skipped.length ? "\n\nAlready on npm: " + skipped.map((s) => "\`" + s + "\`").join(", ") : ""));
}

async function publish() {
  const dir = path.resolve(process.env.PACK_DIRECTORY);
  const dryRun = parseBool("dry-run", process.env.INPUT_DRY_RUN);
  const tag = String(process.env.INPUT_DIST_TAG || "").trim();
  const access = String(process.env.INPUT_ACCESS || "public").trim();
  const provenance = String(process.env.INPUT_PROVENANCE || "auto").trim();
  if (tag && !TAG_RE.test(tag)) throw new Error("invalid dist-tag '" + tag + "'");
  if (!["public", "restricted"].includes(access)) throw new Error("access must be public or restricted");
  if (!["auto", "true", "false"].includes(provenance)) throw new Error("provenance must be auto, true or false");

  const { packages: plan } = readJson(path.join(dir, "plan.json"));
  for (const entry of plan) {
    if (!NAME_RE.test(entry.name) || !VERSION_RE.test(entry.version) || path.basename(entry.file) !== entry.file) throw new Error("invalid plan entry " + JSON.stringify(entry));
    checkTarball(path.join(dir, entry.file), entry);
  }
  if (!plan.length) {
    console.log("Nothing to publish.");
    setOutput("published", "[]");
    return;
  }

  const version = npmVersion();
  if (!dryRun) {
    if (!supportsTrustedPublishing(version)) throw new Error("npm " + version + " cannot use trusted publishing; it needs npm 11.5.1 or newer (Node.js 24 bundles it)");
    if (process.env.RUNNER_ENVIRONMENT && process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new Error("npm trusted publishing works only on GitHub-hosted runners, not " + process.env.RUNNER_ENVIRONMENT);
    if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error("npm trusted publishing needs 'permissions: id-token: write' on the job");
    const files = storedTokenFiles([path.join(os.homedir(), ".npmrc"), process.env.NPM_CONFIG_USERCONFIG, path.join(process.cwd(), ".npmrc")]);
    if (files.length) throw new Error("a stored npm token in " + files.join(", ") + " would bypass trusted publishing; remove it");
  }

  const isPublic = process.env.REPOSITORY_VISIBILITY === "public";
  const common = ["--access", access, "--ignore-scripts"];
  if (tag) common.push("--tag", tag);
  if (provenance === "true" || (provenance === "auto" && isPublic)) common.push("--provenance");
  else common.push("--provenance=false");
  if (dryRun) common.push("--dry-run");

  // setup-node's registry-url writes NODE_AUTH_TOKEN into .npmrc; a placeholder there makes npm
  // send it instead of exchanging the OIDC token.
  const env = { ...process.env, NODE_AUTH_TOKEN: "", NPM_TOKEN: "", NPM_CONFIG_IGNORE_SCRIPTS: "true" };
  for (const k of Object.keys(env)) if (/^npm_config_(_auth|_authtoken|\/\/)/i.test(k)) delete env[k];

  const published = [];
  for (const entry of plan) {
    if (!dryRun && (await publishedVersions(entry.name)).has(entry.version)) {
      console.log("::notice::" + entry.name + "@" + entry.version + " is already on npm");
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      console.log("::group::npm publish " + entry.name + "@" + entry.version + (attempt > 1 ? " (attempt " + attempt + ")" : ""));
      const res = run("npm", ["publish", path.join(dir, entry.file), ...common], { env });
      process.stdout.write(res.stdout);
      process.stdout.write(res.stderr);
      console.log("::endgroup::");
      if (res.status === 0) {
        published.push({ name: entry.name, version: entry.version });
        break;
      }
      const out = res.stdout + res.stderr;
      if (/previously staged version|cannot publish over the previously published versions?/i.test(out)) {
        console.log("::notice::" + entry.name + "@" + entry.version + " is already published or staged on npm");
        break;
      }
      const transient = /\b(E5\d\d|ETIMEDOUT|ECONNRESET|EAI_AGAIN|E429)\b/.test(out);
      if (!transient || attempt >= 4) {
        setOutput("published", JSON.stringify(published));
        throw new Error("publishing " + entry.name + "@" + entry.version + " failed");
      }
      await sleep(15000 * attempt);
    }
  }
  setOutput("published", JSON.stringify(published));
  summary((dryRun ? "Dry run, would publish: " : "Published: ") + (published.map((p) => "\`" + p.name + "@" + p.version + "\`").join(", ") || "nothing"));
}

module.exports = { splitList, orderPackages, selectPackages, publishedVersions, changelogSection, checkTarball, supportsTrustedPublishing, storedTokenFiles, detectPackageManager };

if (require.main === module) {
  const mode = process.argv[2];
  const fn = mode === "pack" ? pack : mode === "publish" ? publish : null;
  if (!fn) {
    console.error("usage: publish.cjs pack|publish");
    process.exit(2);
  }
  fn().catch((err) => {
    console.log("::error::" + String(err.message).replace(/\n/g, "%0A"));
    process.exit(1);
  });
}
