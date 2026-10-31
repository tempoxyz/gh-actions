#!/usr/bin/env node
// Plans and runs crates.io publishes for a Cargo workspace.
//
//   node publish.cjs plan      resolve the packages to publish, in dependency order
//   node publish.cjs publish   publish the planned packages (or dry-run them)
//
// Inputs come from INPUT_* environment variables set by action.yml; nothing is read from argv
// except the mode, so workflow expressions never reach a shell.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const INDEX_URL = "https://index.crates.io";
// Upload only within the first 25 of the token's 30 minutes.
const TOKEN_BUDGET_MS = 25 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function splitList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(name, value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false" || v === "") return false;
  throw new Error(name + " must be 'true' or 'false', got '" + value + "'");
}

function parseNonNegativeInt(name, value) {
  const v = String(value ?? "").trim();
  if (!/^\d+$/.test(v)) throw new Error(name + " must be a non-negative integer, got '" + value + "'");
  return Number(v);
}

// Path of a crate's file in the sparse index (https://doc.rust-lang.org/cargo/reference/registry-index.html#index-files).
function indexPath(name) {
  const n = name.toLowerCase();
  if (n.length === 1) return "1/" + n;
  if (n.length === 2) return "2/" + n;
  if (n.length === 3) return "3/" + n[0] + "/" + n;
  return n.slice(0, 2) + "/" + n.slice(2, 4) + "/" + n;
}

function publishesToCratesIo(pkg) {
  // publish: null means any registry; [] means publish = false.
  return pkg.publish === null || pkg.publish === undefined || pkg.publish.includes("crates-io");
}

// Returns workspace packages to publish, ordered so every package comes after the workspace
// packages it depends on. Normal and build dependencies are hard edges. cargo publish strips a
// path dev-dependency without a version, but keeps a versioned one in the uploaded manifest, and
// crates.io rejects it until that crate exists; those are soft edges, dropped only to break a
// cycle (then the dev-dependency must already be on crates.io at a matching version).
function planPackages(metadata, { packages = [], exclude = [], onRegistry = new Set() } = {}) {
  const members = new Set(metadata.workspace_members);
  const byName = new Map();
  for (const pkg of metadata.packages) {
    if (members.has(pkg.id)) byName.set(pkg.name, pkg);
  }

  for (const name of [...packages, ...exclude]) {
    if (!NAME_RE.test(name)) throw new Error("invalid package name '" + name + "'");
    if (!byName.has(name)) throw new Error("'" + name + "' is not a workspace member");
  }

  let selected;
  if (packages.length > 0) {
    selected = packages.map((name) => byName.get(name));
    const blocked = selected.filter((pkg) => !publishesToCratesIo(pkg)).map((pkg) => pkg.name);
    if (blocked.length) throw new Error("not publishable to crates.io (publish = false or another registry): " + blocked.join(", "));
  } else {
    selected = [...byName.values()].filter(publishesToCratesIo);
  }
  const excluded = new Set(exclude);
  selected = selected.filter((pkg) => !excluded.has(pkg.name));
  const selectedNames = new Set(selected.map((pkg) => pkg.name));

  const deps = new Map();
  const soft = new Map();
  const problems = [];
  for (const pkg of selected) {
    const internal = new Set();
    const devEdges = new Set();
    for (const dep of pkg.dependencies) {
      const target = byName.get(dep.name);
      if (!target || !dep.path || dep.name === pkg.name) continue;
      if (dep.kind === "dev") {
        if (dep.req && dep.req !== "*" && selectedNames.has(dep.name)) devEdges.add(dep.name);
        continue;
      }
      if (selectedNames.has(dep.name)) {
        internal.add(dep.name);
      } else if (!publishesToCratesIo(target)) {
        problems.push(pkg.name + " depends on " + dep.name + ", which is not published to crates.io");
      }
      // A publishable member outside the selection must already be on crates.io at a version
      // matching the requirement; cargo publish's own verification reports it if it is not.
    }
    deps.set(pkg.name, internal);
    soft.set(pkg.name, devEdges);
  }
  if (problems.length) throw new Error(problems.join("\n"));

  // Kahn's algorithm, ties broken by name so the order is stable.
  const order = [];
  const remaining = new Map([...deps].map(([name, d]) => [name, new Set(d)]));
  const remainingSoft = new Map([...soft].map(([name, d]) => [name, new Set(d)]));
  while (remaining.size) {
    let ready = [...remaining].filter(([name, d]) => d.size === 0 && remainingSoft.get(name).size === 0).map(([name]) => name);
    if (!ready.length) {
      // Every crate waits on something. Break a cycle that includes dev-dependency edges: pick a
      // strongly connected component with no edges leaving it (so its crates wait only on each
      // other), take its first crate with no normal/build dependencies left, and drop that crate's
      // dev-dependency edges, which all stay inside the component and so all lie on a cycle.
      const pick = breakSoftCycle(remaining, remainingSoft, onRegistry);
      if (!pick) throw new Error("dependency cycle between: " + [...remaining.keys()].sort().join(", "));
      ready = [pick];
    }
    for (const name of ready.sort()) {
      order.push(name);
      remaining.delete(name);
      remainingSoft.delete(name);
      for (const d of remaining.values()) d.delete(name);
      for (const d of remainingSoft.values()) d.delete(name);
    }
  }
  return order.map((name) => ({ name, version: byName.get(name).version }));
}

// Tarjan's strongly connected components over the remaining hard and soft edges. Returns the
// crate whose soft edges to drop, or null when only normal/build dependencies form the cycle.
// onRegistry holds crates whose planned version is already on crates.io. Among the candidates it
// prefers the fewest dropped edges to crates outside it (those uploads would be rejected), then
// the fewest dropped edges, then the name.
function breakSoftCycle(hard, soft, onRegistry = new Set()) {
  const edges = (n) => [...hard.get(n), ...soft.get(n)];
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], comps = [];
  let next = 0;
  const visit = (v) => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); onStack.add(v);
    for (const w of edges(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = new Set();
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.add(w); } while (w !== v);
      comps.push(comp);
    }
  };
  for (const v of [...hard.keys()].sort()) if (!index.has(v)) visit(v);
  const candidates = [];
  for (const comp of comps) {
    const sink = [...comp].every((n) => edges(n).every((w) => comp.has(w)));
    if (!sink || comp.size < 2) continue;
    for (const n of comp) if (hard.get(n).size === 0) candidates.push(n);
  }
  const cost = (n) => {
    // A crate whose version is already published is never uploaded, so its edges cost nothing.
    if (onRegistry.has(n)) return [0, 0];
    const dropped = [...soft.get(n)];
    return [dropped.filter((d) => !onRegistry.has(d)).length, dropped.length];
  };
  candidates.sort((a, b) => {
    const [ca, cb] = [cost(a), cost(b)];
    return ca[0] - cb[0] || ca[1] - cb[1] || (a < b ? -1 : a > b ? 1 : 0);
  });
  return candidates[0] || null;
}

async function publishedVersions(name, fetchImpl = fetch) {
  const url = INDEX_URL + "/" + indexPath(name);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { "User-Agent": "tempoxyz/gh-actions cargo-publish" } });
    } catch (err) {
      if (attempt >= 5) throw new Error("fetching " + url + ": " + err.message);
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 404 || res.status === 403) return new Set();
    if (res.ok) {
      const body = await res.text();
      return new Set(body.split("\n").filter(Boolean).map((line) => JSON.parse(line).vers));
    }
    if (attempt >= 5) throw new Error("fetching " + url + ": HTTP " + res.status);
    await sleep(2000 * attempt);
  }
}

// crates.io's own answer to an upload, as cargo reports it ("the remote server responded with an
// error (status N ...): message"), or "" when the failure happened before the upload (compile,
// verification, packaging). Classification never looks at build output.
function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function registryError(stderr) {
  const m = stripAnsi(stderr).match(/the remote server responded with an error \((status \d{3}[^)]*)\): ?([^\n]*)/);
  return m ? m[1] + ": " + m[2] : "";
}

// How long to wait before retrying a publish crates.io rate limited, or null when the failure was
// not a rate limit.
function rateLimitDelayMs(stderr, attempt, now = Date.now()) {
  const error = registryError(stderr);
  if (!/^status 429\b/.test(error)) return null;
  const m = error.match(/try again after ([^.]+? GMT)/i);
  if (m) {
    const at = Date.parse(m[1]);
    if (!Number.isNaN(at)) return Math.max(at - now, 0) + 5000;
  }
  return Math.min(60000 * 2 ** (attempt - 1), 600000);
}

// True when crates.io (or cargo's pre-upload index check) says this exact version is already there.
function alreadyUploaded(stderr, name, version) {
  const esc = (v) => v.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  stderr = stripAnsi(stderr);
  if (new RegExp("^error: crate " + esc(name) + "@" + esc(version) + " already exists on crates\\.io index", "m").test(stderr)) return true;
  return /already (uploaded|exists)/i.test(registryError(stderr));
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

function cargo(args, { capture = false } = {}) {
  const res = spawnSync("cargo", args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 1024 * 1024 * 1024,
    // Captured output is parsed: keep cargo from colouring it (setup actions often set always).
    env: capture ? { ...process.env, CARGO_TERM_COLOR: "never" } : process.env,
  });
  if (res.error) throw res.error;
  return res;
}

async function plan() {
  const packages = splitList(process.env.INPUT_PACKAGES);
  const exclude = splitList(process.env.INPUT_EXCLUDE);
  // A dry run checks every selected crate, published or not: cargo only warns about an existing version.
  const skipPublished = !parseBool("dry-run", process.env.INPUT_DRY_RUN) && parseBool("skip-published", process.env.INPUT_SKIP_PUBLISHED);

  const meta = cargo(["metadata", "--format-version", "1", "--no-deps"], { capture: true });
  if (meta.status !== 0) {
    process.stderr.write(meta.stderr);
    throw new Error("cargo metadata failed");
  }
  const metadata = JSON.parse(meta.stdout);
  // Look up every selected crate once: the cycle breaker prefers dropping dev-dependency edges to
  // crates that already exist on crates.io, and skip-published needs the versions.
  const versions = new Map();
  const planned = planPackages(metadata, { packages, exclude });
  for (const pkg of planned) versions.set(pkg.name, await publishedVersions(pkg.name));
  // Only the version this release needs counts: after a bump, an older release does not satisfy
  // a sibling's dev-dependency requirement.
  const onRegistry = new Set(planned.filter((pkg) => versions.get(pkg.name).has(pkg.version)).map((pkg) => pkg.name));
  const ordered = planPackages(metadata, { packages, exclude, onRegistry });

  const toPublish = [];
  const skipped = [];
  for (const pkg of ordered) {
    if (skipPublished && versions.get(pkg.name).has(pkg.version)) skipped.push(pkg);
    else toPublish.push(pkg);
  }

  const fmt = (list) => list.map((p) => p.name + "@" + p.version).join(" ");
  console.log("Publish order: " + (fmt(toPublish) || "(nothing)"));
  if (skipped.length) console.log("Already on crates.io, skipped: " + fmt(skipped));
  setOutput("packages", toPublish.map((p) => p.name).join(" "));
  setOutput("skipped", skipped.map((p) => p.name).join(" "));
  setOutput("plan", JSON.stringify(toPublish));
  summary(
    "### cargo publish plan\n\n" +
      (toPublish.length ? toPublish.map((p, i) => (i + 1) + ". \`" + p.name + "@" + p.version + "\`").join("\n") : "Nothing to publish.") +
      (skipped.length ? "\n\nAlready on crates.io: " + skipped.map((p) => "\`" + p.name + "@" + p.version + "\`").join(", ") : ""),
  );
}

async function publish() {
  const list = JSON.parse(process.env.PLAN || "[]");
  const dryRun = parseBool("dry-run", process.env.INPUT_DRY_RUN);
  const locked = parseBool("locked", process.env.INPUT_LOCKED);
  const delayMs = parseNonNegativeInt("delay-seconds", process.env.INPUT_DELAY_SECONDS) * 1000;
  const retries = parseNonNegativeInt("rate-limit-retries", process.env.INPUT_RATE_LIMIT_RETRIES);
  for (const pkg of list) if (!NAME_RE.test(pkg.name)) throw new Error("invalid package name '" + pkg.name + "'");
  if (!list.length) {
    console.log("Nothing to publish.");
    return;
  }

  const common = locked ? ["--locked"] : [];
  if (dryRun) {
    // One invocation so cargo verifies each package against the others' unpublished versions.
    const args = ["publish", "--dry-run", ...common, ...list.flatMap((p) => ["-p", p.name])];
    console.log("cargo " + args.join(" "));
    const res = cargo(args);
    if (res.status !== 0) throw new Error("cargo publish --dry-run failed");
    return;
  }

  if (!process.env.CARGO_REGISTRY_TOKEN) throw new Error("no crates.io token; trusted publishing authentication did not run");
  // The trusted publishing token lasts 30 minutes. Never start an upload or a wait that could
  // outlast it; a rerun resumes after the crates already published (skip-published).
  const issuedAt = Number(process.env.TOKEN_ISSUED_AT || "0") * 1000 || Date.now();
  const deadline = issuedAt + TOKEN_BUDGET_MS;
  const outOfTime = (pkg, waitMs) => {
    if (Date.now() + waitMs <= deadline) return false;
    setOutput("published", published.map((p) => p.name).join(" "));
    throw new Error("stopping before " + pkg.name + "@" + pkg.version + ": the crates.io token expires soon. Published so far: " + (published.map((p) => p.name).join(" ") || "nothing") + ". Rerun the job to continue; crates already on crates.io are skipped");
  };

  const published = [];
  for (const [i, pkg] of list.entries()) {
    if (i > 0 && delayMs) {
      outOfTime(pkg, delayMs);
      await sleep(delayMs);
    }
    outOfTime(pkg, 0);
    for (let attempt = 1; ; attempt++) {
      console.log("::group::cargo publish -p " + pkg.name + " (" + pkg.version + ")" + (attempt > 1 ? ", attempt " + attempt : ""));
      const res = cargo(["publish", ...common, "-p", pkg.name], { capture: true });
      process.stdout.write(res.stdout);
      process.stdout.write(res.stderr);
      console.log("::endgroup::");
      if (res.status === 0) {
        published.push(pkg);
        break;
      }
      if (alreadyUploaded(res.stderr, pkg.name, pkg.version)) {
        console.log("::notice::" + pkg.name + "@" + pkg.version + " is already on crates.io");
        break;
      }
      const wait = rateLimitDelayMs(res.stderr, attempt);
      if (wait === null || attempt > retries) {
        setOutput("published", published.map((p) => p.name).join(" "));
        throw new Error("publishing " + pkg.name + "@" + pkg.version + " failed" + (wait === null ? "" : " after " + retries + " rate-limit retries"));
      }
      outOfTime(pkg, wait);
      console.log("::warning::crates.io rate limited " + pkg.name + "; retrying in " + Math.ceil(wait / 1000) + "s");
      await sleep(wait);
    }
  }
  setOutput("published", published.map((p) => p.name).join(" "));
  summary("Published: " + (published.map((p) => "\`" + p.name + "@" + p.version + "\`").join(", ") || "nothing"));
}

module.exports = { splitList, parseBool, indexPath, planPackages, publishedVersions, registryError, rateLimitDelayMs, alreadyUploaded };

if (require.main === module) {
  const mode = process.argv[2];
  const run = mode === "plan" ? plan : mode === "publish" ? publish : null;
  if (!run) {
    console.error("usage: publish.cjs plan|publish");
    process.exit(2);
  }
  run().catch((err) => {
    console.log("::error::" + err.message.replace(/\n/g, "%0A"));
    process.exit(1);
  });
}
