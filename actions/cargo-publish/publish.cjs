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
// packages it depends on (normal and build dependencies; dev-dependencies are stripped of
// path-only entries by cargo publish and do not constrain the order).
function planPackages(metadata, { packages = [], exclude = [] } = {}) {
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
  const problems = [];
  for (const pkg of selected) {
    const internal = new Set();
    for (const dep of pkg.dependencies) {
      if (dep.kind === "dev") continue;
      const target = byName.get(dep.name);
      if (!target || !dep.path) continue;
      if (selectedNames.has(dep.name)) {
        internal.add(dep.name);
      } else if (!publishesToCratesIo(target)) {
        problems.push(pkg.name + " depends on " + dep.name + ", which is not published to crates.io");
      }
      // A publishable member outside the selection must already be on crates.io at a version
      // matching the requirement; cargo publish's own verification reports it if it is not.
    }
    deps.set(pkg.name, internal);
  }
  if (problems.length) throw new Error(problems.join("\n"));

  // Kahn's algorithm, ties broken by name so the order is stable.
  const order = [];
  const remaining = new Map([...deps].map(([name, d]) => [name, new Set(d)]));
  while (remaining.size) {
    const ready = [...remaining].filter(([, d]) => d.size === 0).map(([name]) => name).sort();
    if (!ready.length) throw new Error("dependency cycle between: " + [...remaining.keys()].sort().join(", "));
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const d of remaining.values()) d.delete(name);
    }
  }
  return order.map((name) => ({ name, version: byName.get(name).version }));
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

// How long to wait before retrying a publish that crates.io rate limited, or null when the
// failure was not a rate limit.
function rateLimitDelayMs(output, attempt, now = Date.now()) {
  if (!/429|too many requests|rate limit/i.test(output)) return null;
  const m = output.match(/try again after ([^\n.]+?GMT)/i);
  if (m) {
    const at = Date.parse(m[1]);
    if (!Number.isNaN(at)) return Math.max(at - now, 0) + 5000;
  }
  return Math.min(60000 * 2 ** (attempt - 1), 600000);
}

function alreadyUploaded(output) {
  return /already (exists|uploaded)/i.test(output);
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
    env: process.env,
  });
  if (res.error) throw res.error;
  return res;
}

async function plan() {
  const packages = splitList(process.env.INPUT_PACKAGES);
  const exclude = splitList(process.env.INPUT_EXCLUDE);
  const skipPublished = parseBool("skip-published", process.env.INPUT_SKIP_PUBLISHED);

  const meta = cargo(["metadata", "--format-version", "1", "--no-deps"], { capture: true });
  if (meta.status !== 0) {
    process.stderr.write(meta.stderr);
    throw new Error("cargo metadata failed");
  }
  const ordered = planPackages(JSON.parse(meta.stdout), { packages, exclude });

  const toPublish = [];
  const skipped = [];
  for (const pkg of ordered) {
    if (skipPublished && (await publishedVersions(pkg.name)).has(pkg.version)) skipped.push(pkg);
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

  const published = [];
  for (const [i, pkg] of list.entries()) {
    if (i > 0 && delayMs) await sleep(delayMs);
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
      const output = res.stdout + res.stderr;
      if (alreadyUploaded(output)) {
        console.log("::notice::" + pkg.name + "@" + pkg.version + " is already on crates.io");
        break;
      }
      const wait = rateLimitDelayMs(output, attempt);
      if (wait === null || attempt > retries) {
        setOutput("published", published.map((p) => p.name).join(" "));
        throw new Error("publishing " + pkg.name + "@" + pkg.version + " failed" + (wait === null ? "" : " after " + retries + " rate-limit retries"));
      }
      console.log("::warning::crates.io rate limited " + pkg.name + "; retrying in " + Math.ceil(wait / 1000) + "s");
      await sleep(wait);
    }
  }
  setOutput("published", published.map((p) => p.name).join(" "));
  summary("Published: " + (published.map((p) => "\`" + p.name + "@" + p.version + "\`").join(", ") || "nothing"));
}

module.exports = { splitList, parseBool, indexPath, planPackages, publishedVersions, rateLimitDelayMs, alreadyUploaded };

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
