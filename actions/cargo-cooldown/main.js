const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+sparse+https://index.crates.io/",
  "sparse+https://index.crates.io/",
]);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RETRIES = 3;

function input(name) {
  const key = name.toUpperCase();
  return process.env[`INPUT_${key}`] || process.env[`INPUT_${key.replaceAll("-", "_")}`] || "";
}

function annotation(message) {
  console.error(`::error::${String(message).replace(/[\r\n]+/g, " ")}`);
}

function crateIndexPath(name) {
  const normalized = name.toLowerCase();
  if (normalized.length === 1) return `1/${normalized}`;
  if (normalized.length === 2) return `2/${normalized}`;
  if (normalized.length === 3) return `3/${normalized[0]}/${normalized}`;
  return `${normalized.slice(0, 2)}/${normalized.slice(2, 4)}/${normalized}`;
}

function unquote(value, lineNumber) {
  const match = value.match(/^("(?:[^"\\]|\\.)*"|'[^']*')$/);
  if (!match) throw new Error(`allowlist line ${lineNumber}: expected a quoted string`);
  if (value.startsWith("'")) return value.slice(1, -1);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`allowlist line ${lineNumber}: invalid quoted string`);
  }
}

function parseAllowlist(contents) {
  const result = { exact: new Set(), packageDays: new Map() };
  let record = null;

  function finishRecord() {
    if (!record) return;
    if (record.type === "exact") {
      if (!record.crate || !record.version) {
        throw new Error("each [[allow.exact]] entry requires crate and version");
      }
      result.exact.add(`${record.crate}@${record.version}`);
    } else {
      if (!record.crate || !Number.isInteger(record.days) || record.days < 0) {
        throw new Error("each [[allow.package]] entry requires crate and non-negative whole days");
      }
      result.packageDays.set(record.crate, record.days);
    }
  }

  for (const [index, original] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = original.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const section = line.match(/^\[\[allow\.(exact|package)\]\]$/);
    if (section) {
      finishRecord();
      record = { type: section[1] };
      continue;
    }
    if (!record) throw new Error(`allowlist line ${lineNumber}: value outside an allow entry`);

    const assignment = line.match(/^([a-z]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`allowlist line ${lineNumber}: invalid assignment`);
    const [, key, rawValue] = assignment;
    if (key === "crate" || key === "version") {
      if (key === "version" && record.type !== "exact") {
        throw new Error(`allowlist line ${lineNumber}: version is only valid for allow.exact`);
      }
      record[key] = unquote(rawValue, lineNumber);
    } else if (key === "days" && record.type === "package") {
      if (!/^\d+$/.test(rawValue)) {
        throw new Error(`allowlist line ${lineNumber}: days must be a non-negative whole number`);
      }
      record.days = Number(rawValue);
    } else {
      throw new Error(`allowlist line ${lineNumber}: unsupported field ${key}`);
    }
  }
  finishRecord();
  return result;
}

function requestIndex(crate, dependencies = {}) {
  const get = dependencies.get || https.get;
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const url = `https://index.crates.io/${crateIndexPath(crate)}`;

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const send = () => {
      attempt += 1;
      const request = get(url, {
        headers: {
          Accept: "text/plain",
          "User-Agent": "tempoxyz-gh-actions-cargo-cooldown",
        },
      }, (response) => {
        const status = response.statusCode || 0;
        if ([408, 425, 429].includes(status) || status >= 500) {
          response.resume();
          if (attempt <= MAX_RETRIES) {
            void sleep(500 * 2 ** (attempt - 1)).then(send, reject);
          } else {
            reject(new Error(`crates.io index request for ${crate} failed after ${attempt} attempts (HTTP ${status})`));
          }
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`crates.io index request for ${crate} returned HTTP ${status}`));
          return;
        }

        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
            response.destroy(new Error(`crates.io index response for ${crate} is too large`));
          }
        });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      });
      request.setTimeout(15_000, () => request.destroy(new Error(`crates.io index request for ${crate} timed out`)));
      request.on("error", (error) => {
        if (attempt <= MAX_RETRIES) {
          void sleep(500 * 2 ** (attempt - 1)).then(send, reject);
        } else {
          reject(new Error(`crates.io index request for ${crate} failed after ${attempt} attempts: ${error.message}`));
        }
      });
    };
    send();
  });
}

function publicationTimes(crate, body) {
  const versions = new Map();
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`invalid crates.io index JSON for ${crate} on line ${index + 1}`);
    }
    if (typeof entry.vers === "string") versions.set(entry.vers, entry.pubtime);
  }
  return versions;
}

async function mapConcurrent(values, limit, operation) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function checkPackages(packages, options, dependencies = {}) {
  const crates = [...new Set(packages.map((pkg) => pkg.name))].sort();
  const fetchIndex = dependencies.fetchIndex || requestIndex;
  const bodies = await mapConcurrent(crates, 8, async (crate) => [crate, await fetchIndex(crate)]);
  const indexes = new Map(bodies.map(([crate, body]) => [crate, publicationTimes(crate, body)]));
  const violations = [];

  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (options.allowlist.exact.has(key)) {
      console.log(`Allowed exact exception: ${key}`);
      continue;
    }
    const rawTime = indexes.get(pkg.name).get(pkg.version);
    if (typeof rawTime !== "string") throw new Error(`crates.io index has no publication timestamp for ${key}`);
    const publishedAt = Date.parse(rawTime);
    if (!Number.isFinite(publishedAt)) throw new Error(`crates.io index has an invalid publication timestamp for ${key}`);
    const days = options.allowlist.packageDays.get(pkg.name) ?? options.cooldownDays;
    const eligibleAt = publishedAt + days * 86_400_000;
    if (options.verbose) console.log(`${key}: published ${rawTime}, cooldown ${days} day(s)`);
    if (options.now < eligibleAt) violations.push({ key, rawTime, eligibleAt, days });
  }
  return violations;
}

async function main(dependencies = {}) {
  const rawDays = input("cooldown-days") || "7";
  if (!/^[1-9]\d*$/.test(rawDays)) throw new Error("cooldown-days must be a positive whole number");
  const verboseInput = input("verbose") || "false";
  if (verboseInput !== "true" && verboseInput !== "false") throw new Error("verbose must be 'true' or 'false'");

  const workingDirectory = path.resolve(input("working-directory") || ".");
  const runCargo = dependencies.runCargo || ((cwd) => spawnSync(
    "cargo",
    ["metadata", "--locked", "--all-features", "--format-version", "1"],
    { cwd, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  ));
  const cargo = runCargo(workingDirectory);
  if (cargo.error) throw new Error(`could not run Cargo: ${cargo.error.message}`);
  if (cargo.status !== 0) throw new Error(`cargo metadata failed: ${(cargo.stderr || "unknown error").trim()}`);

  let metadata;
  try {
    metadata = JSON.parse(cargo.stdout);
  } catch {
    throw new Error("cargo metadata returned invalid JSON");
  }
  if (!Array.isArray(metadata.packages) || typeof metadata.workspace_root !== "string") {
    throw new Error("cargo metadata response is missing packages or workspace_root");
  }

  const allowlistPath = path.join(metadata.workspace_root, ".cargo", "cooldown-allowlist.toml");
  const allowlist = fs.existsSync(allowlistPath)
    ? parseAllowlist(fs.readFileSync(allowlistPath, "utf8"))
    : { exact: new Set(), packageDays: new Map() };
  const packages = metadata.packages.filter((pkg) => CRATES_IO_SOURCES.has(pkg.source));
  const skipped = metadata.packages.filter((pkg) => pkg.source && !CRATES_IO_SOURCES.has(pkg.source));
  if (skipped.length > 0) console.log(`Skipped ${skipped.length} package(s) not sourced from crates.io.`);

  const violations = await checkPackages(packages, {
    allowlist,
    cooldownDays: Number(rawDays),
    now: dependencies.now ?? Date.now(),
    verbose: verboseInput === "true",
  }, dependencies);
  if (violations.length > 0) {
    for (const violation of violations) {
      annotation(`${violation.key} was published ${violation.rawTime}; it is not eligible until ${new Date(violation.eligibleAt).toISOString()} (${violation.days}-day cooldown)`);
    }
    throw new Error(`${violations.length} crates.io package(s) violate the cooldown policy`);
  }
  console.log(`Cargo cooldown passed for ${packages.length} crates.io package(s).`);
}

if (require.main === module) {
  main().catch((error) => {
    annotation(`Cargo cooldown could not prove that the dependency graph satisfies policy; failing closed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { checkPackages, crateIndexPath, main, parseAllowlist, publicationTimes };
