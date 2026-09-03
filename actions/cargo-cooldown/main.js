const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CRATES_IO_SOURCES = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "registry+sparse+https://index.crates.io/",
  "sparse+https://index.crates.io/",
]);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_RETRIES = 3;
const SPARSE_CACHE_FORMAT = 3;
const SPARSE_INDEX_FORMAT = 2;

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

function parseCargoLock(contents) {
  if (Buffer.byteLength(contents) > MAX_LOCKFILE_BYTES) throw new Error("Cargo.lock is too large");
  const packages = [];
  let lockfileVersion = null;
  let record = null;
  let atTopLevel = true;

  function finishRecord() {
    if (!record) return;
    if (!record.name || !record.version) {
      throw new Error("each Cargo.lock [[package]] entry requires name and version");
    }
    packages.push({
      name: record.name,
      version: record.version,
      source: record.source ?? null,
    });
    record = null;
  }

  for (const [index, original] of contents.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[package]]") {
      finishRecord();
      record = {};
      atTopLevel = false;
      continue;
    }
    if (line.startsWith("[[")) {
      throw new Error(`Cargo.lock line ${lineNumber}: unsupported array table`);
    }
    if (line.startsWith("[")) {
      finishRecord();
      atTopLevel = false;
      continue;
    }

    if (!record) {
      if (atTopLevel) {
        const version = line.match(/^version\s*=\s*(\d+)$/);
        if (version) {
          if (lockfileVersion !== null) throw new Error(`Cargo.lock line ${lineNumber}: duplicate lockfile version`);
          lockfileVersion = Number(version[1]);
        } else if (/^version\s*=/.test(line)) {
          throw new Error(`Cargo.lock line ${lineNumber}: malformed lockfile version`);
        }
      }
      continue;
    }

    const assignment = line.match(/^(name|version|source)\s*=\s*"([^"\\]*)"$/);
    if (assignment) {
      const [, key, value] = assignment;
      if (Object.hasOwn(record, key)) throw new Error(`Cargo.lock line ${lineNumber}: duplicate package ${key}`);
      record[key] = value;
    } else if (/^(name|version|source)\s*=/.test(line)) {
      throw new Error(`Cargo.lock line ${lineNumber}: malformed package field`);
    }
  }
  finishRecord();

  if (lockfileVersion !== 3 && lockfileVersion !== 4) {
    throw new Error(`unsupported Cargo.lock format version ${String(lockfileVersion)}`);
  }
  if (packages.length === 0) throw new Error("Cargo.lock contains no package entries");
  return packages;
}

function abortError() {
  const error = new Error("crates.io index request was aborted");
  error.name = "AbortError";
  return error;
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function requestIndexOnce(crate, dependencies) {
  const get = dependencies.get || https.get;
  const signal = dependencies.signal;
  const url = `https://index.crates.io/${crateIndexPath(crate)}`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    let request;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      const error = abortError();
      fail(error);
      request?.destroy(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      request = get(url, {
        headers: {
          Accept: "text/plain",
          "User-Agent": "tempoxyz-gh-actions-cargo-cooldown",
        },
      }, (response) => {
        const status = response.statusCode || 0;
        if ([408, 425, 429].includes(status) || status >= 500) {
          response.resume();
          fail(retryableError(`HTTP ${status}`));
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(new Error(`crates.io index request for ${crate} returned HTTP ${status}`));
          return;
        }

        response.setEncoding("utf8");
        const chunks = [];
        let receivedBytes = 0;
        response.on("data", (chunk) => {
          receivedBytes += Buffer.byteLength(chunk);
          if (receivedBytes > MAX_RESPONSE_BYTES) {
            const error = new Error(`crates.io index response for ${crate} is too large`);
            fail(error);
            response.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => succeed(chunks.join("")));
        response.on("aborted", () => fail(retryableError("response was aborted")));
        response.on("error", (error) => fail(retryableError(error.message)));
      });
      request.setTimeout(15_000, () => {
        const error = retryableError("request timed out");
        fail(error);
        request.destroy(error);
      });
      request.on("error", (error) => {
        if (signal?.aborted || error.name === "AbortError") fail(abortError());
        else fail(retryableError(error.message));
      });
    } catch (error) {
      fail(error);
    }
  });
}

async function retryDelay(milliseconds, dependencies) {
  const signal = dependencies.signal;
  if (signal?.aborted) throw abortError();
  if (dependencies.sleep) {
    await dependencies.sleep(milliseconds);
    if (signal?.aborted) throw abortError();
    return;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestIndex(crate, dependencies = {}) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    try {
      return await requestIndexOnce(crate, dependencies);
    } catch (error) {
      if (!error.retryable || error.name === "AbortError") throw error;
      if (attempt > MAX_RETRIES) {
        throw new Error(`crates.io index request for ${crate} failed after ${attempt} attempts: ${error.message}`);
      }
      await retryDelay(500 * 2 ** (attempt - 1), dependencies);
    }
  }
  throw new Error(`crates.io index request for ${crate} exhausted its retry budget`);
}

function addPublicationEntry(versions, crate, declaredVersion, rawEntry, location) {
  if (typeof declaredVersion !== "string" || declaredVersion.length === 0) {
    throw new Error(`invalid crates.io index version for ${crate} at ${location}`);
  }
  let entry;
  try {
    entry = JSON.parse(rawEntry);
  } catch {
    throw new Error(`invalid crates.io index JSON for ${crate} at ${location}`);
  }
  if (entry.name !== crate || entry.vers !== declaredVersion) {
    throw new Error(`crates.io index identity mismatch for ${crate}@${declaredVersion} at ${location}`);
  }
  if (versions.has(declaredVersion)) {
    throw new Error(`duplicate crates.io index entry for ${crate}@${declaredVersion}`);
  }
  versions.set(declaredVersion, entry.pubtime);
}

function publicationTimes(crate, body, requestedVersions) {
  const versions = new Map();
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`invalid crates.io index JSON for ${crate} on line ${index + 1}`);
    }
    if (requestedVersions && !requestedVersions.has(entry.vers)) continue;
    addPublicationEntry(versions, crate, entry.vers, line, `line ${index + 1}`);
  }
  return versions;
}

function sparseCachePublicationTimes(crate, contents, requestedVersions) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`Cargo sparse-index cache entry for ${crate} is too large`);
  if (buffer.length < 6 || buffer[0] !== SPARSE_CACHE_FORMAT) {
    throw new Error(`unsupported Cargo sparse-index cache format for ${crate}`);
  }
  if (buffer.readUInt32LE(1) !== SPARSE_INDEX_FORMAT) {
    throw new Error(`unsupported crates.io index format in Cargo cache for ${crate}`);
  }

  const fields = buffer.subarray(5).toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const revision = fields.shift();
  if (!revision || fields.length === 0 || fields.length % 2 !== 0) {
    throw new Error(`malformed Cargo sparse-index cache entry for ${crate}`);
  }

  const versions = new Map();
  for (let index = 0; index < fields.length; index += 2) {
    const declaredVersion = fields[index];
    if (!declaredVersion) throw new Error(`malformed Cargo sparse-index cache version for ${crate}`);
    if (requestedVersions && !requestedVersions.has(declaredVersion)) continue;
    addPublicationEntry(versions, crate, declaredVersion, fields[index + 1], `cached version ${declaredVersion}`);
  }
  return versions;
}

function validPublicationTime(value) {
  const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  return typeof value === "string" && rfc3339.test(value) && Number.isFinite(Date.parse(value));
}

async function readCachedPublicationTimes(crate, requestedVersions, cargoHome) {
  const indexRoot = path.join(cargoHome, "registry", "index");
  let directories;
  try {
    directories = fs.readdirSync(indexRoot, { withFileTypes: true });
  } catch {
    return new Map();
  }

  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith("index.crates.io-")) continue;
    const cachePath = path.join(indexRoot, directory.name, ".cache", crateIndexPath(crate));
    let contents;
    try {
      const stat = fs.statSync(cachePath);
      if (stat.size > MAX_RESPONSE_BYTES) continue;
      contents = fs.readFileSync(cachePath);
    } catch {
      continue;
    }

    let versions;
    try {
      versions = sparseCachePublicationTimes(crate, contents, requestedVersions);
    } catch {
      continue;
    }
    if ([...requestedVersions].every((version) => validPublicationTime(versions.get(version)))) {
      return versions;
    }
  }
  return new Map();
}

async function mapConcurrent(values, limit, operation, onError = () => {}) {
  const results = new Array(values.length);
  let next = 0;
  let stopped = false;
  async function worker() {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index]);
      } catch (error) {
        stopped = true;
        onError(error);
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function resolvePublicationTimes(crate, requestedVersions, options, dependencies) {
  const readCache = dependencies.readCachedPublicationTimes || readCachedPublicationTimes;
  let cached = new Map();
  try {
    cached = await readCache(crate, requestedVersions, options.cargoHome);
  } catch {
    // Cargo's cache is an optimization and uses an internal format. Anything unfamiliar falls
    // back to the authoritative sparse index; failure there still fails the action closed.
  }
  if ([...requestedVersions].every((version) => validPublicationTime(cached.get(version)))) {
    return { crate, source: "cache", versions: cached };
  }

  const fetchIndex = dependencies.fetchIndex || requestIndex;
  const body = await fetchIndex(crate, { signal: options.signal });
  const remote = publicationTimes(crate, body, requestedVersions);
  for (const version of requestedVersions) {
    const rawTime = remote.get(version);
    if (typeof rawTime !== "string") {
      throw new Error(`crates.io index has no publication timestamp for ${crate}@${version}`);
    }
    if (!validPublicationTime(rawTime)) {
      throw new Error(`crates.io index has an invalid publication timestamp for ${crate}@${version}`);
    }
  }
  return { crate, source: "remote", versions: remote };
}

async function checkPackages(packages, options, dependencies = {}) {
  const required = [];
  let exemptions = 0;
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (options.allowlist.exact.has(key)) {
      exemptions += 1;
      console.log(`Allowed exact exception without index lookup: ${key}`);
      continue;
    }
    const days = options.allowlist.packageDays.get(pkg.name) ?? options.cooldownDays;
    if (days === 0) {
      exemptions += 1;
      console.log(`Allowed zero-day package exception without index lookup: ${key}`);
      continue;
    }
    required.push({ ...pkg, days });
  }

  const requestedByCrate = new Map();
  for (const pkg of required) {
    if (!requestedByCrate.has(pkg.name)) requestedByCrate.set(pkg.name, new Set());
    requestedByCrate.get(pkg.name).add(pkg.version);
  }
  const requests = [...requestedByCrate.entries()].sort(([left], [right]) => left.localeCompare(right));
  const controller = new AbortController();
  const resolveOptions = { ...options, signal: controller.signal };
  const resolved = await mapConcurrent(requests, 8, ([crate, versions]) => (
    resolvePublicationTimes(crate, versions, resolveOptions, dependencies)
  ), () => controller.abort());
  const indexes = new Map(resolved.map((entry) => [entry.crate, entry.versions]));
  const violations = [];

  for (const pkg of required) {
    const key = `${pkg.name}@${pkg.version}`;
    const rawTime = indexes.get(pkg.name).get(pkg.version);
    const publishedAt = Date.parse(rawTime);
    const eligibleAt = publishedAt + pkg.days * 86_400_000;
    if (options.verbose) console.log(`${key}: published ${rawTime}, cooldown ${pkg.days} day(s)`);
    if (options.now < eligibleAt) violations.push({ key, rawTime, eligibleAt, days: pkg.days });
  }
  return {
    violations,
    stats: {
      cacheHits: resolved.filter((entry) => entry.source === "cache").length,
      checkedPackages: required.length,
      exemptions,
      remoteFallbacks: resolved.filter((entry) => entry.source === "remote").length,
      uniqueCrates: requestedByCrate.size,
    },
  };
}

function classifyPackages(packages) {
  const cratesIo = [];
  let skipped = 0;
  for (const pkg of packages) {
    if (pkg.source === null || (typeof pkg.source === "string" && pkg.source.startsWith("git+"))) {
      skipped += 1;
      continue;
    }
    if (CRATES_IO_SOURCES.has(pkg.source)) {
      cratesIo.push(pkg);
      continue;
    }
    throw new Error(`cannot enforce crates.io cooldown for ${pkg.name}@${pkg.version}: unrecognized Cargo source ${String(pkg.source)}`);
  }
  return { cratesIo, skipped };
}

function setOutputs(stats, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  fs.appendFileSync(outputPath, [
    `checked-packages=${stats.checkedPackages}`,
    `cache-hits=${stats.cacheHits}`,
    `remote-fallbacks=${stats.remoteFallbacks}`,
    `exemptions=${stats.exemptions}`,
    "",
  ].join("\n"));
}

async function main(dependencies = {}) {
  const readInput = dependencies.input || input;
  const rawDays = readInput("cooldown-days") || "7";
  if (!/^[1-9]\d*$/.test(rawDays)) throw new Error("cooldown-days must be a positive whole number");
  const verboseInput = readInput("verbose") || "false";
  if (verboseInput !== "true" && verboseInput !== "false") throw new Error("verbose must be 'true' or 'false'");

  const workingDirectory = path.resolve(readInput("working-directory") || ".");
  const runCargo = dependencies.runCargo || ((cwd, args, maxBuffer) => spawnSync(
    "cargo",
    args,
    { cwd, encoding: "utf8", maxBuffer },
  ));
  const locate = runCargo(
    workingDirectory,
    ["locate-project", "--workspace", "--message-format", "json", "--frozen"],
    1024 * 1024,
  );
  if (locate.error) throw new Error(`could not run Cargo: ${locate.error.message}`);
  if (locate.status !== 0) throw new Error(`cargo locate-project failed: ${(locate.stderr || "unknown error").trim()}`);

  let located;
  try {
    located = JSON.parse(locate.stdout);
  } catch {
    throw new Error("cargo locate-project returned invalid JSON");
  }
  if (typeof located.root !== "string" || path.basename(located.root) !== "Cargo.toml") {
    throw new Error("cargo locate-project response is missing the workspace Cargo.toml path");
  }

  const workspaceRoot = path.dirname(path.resolve(located.root));
  const lockfilePath = path.join(workspaceRoot, "Cargo.lock");
  let lockfile;
  try {
    lockfile = fs.readFileSync(lockfilePath, "utf8");
  } catch (error) {
    throw new Error(`could not read workspace Cargo.lock: ${error.message}`);
  }
  const allowlistPath = path.join(workspaceRoot, ".cargo", "cooldown-allowlist.toml");
  const allowlist = fs.existsSync(allowlistPath)
    ? parseAllowlist(fs.readFileSync(allowlistPath, "utf8"))
    : { exact: new Set(), packageDays: new Map() };
  const { cratesIo: packages, skipped } = classifyPackages(parseCargoLock(lockfile));
  if (skipped > 0) console.log(`Skipped ${skipped} local or Git-sourced package(s).`);
  console.log("::notice::Cargo cooldown checks Cargo.lock only; every downstream workspace Cargo command must use --locked.");

  const result = await checkPackages(packages, {
    allowlist,
    cargoHome: path.resolve(process.env.CARGO_HOME || path.join(os.homedir(), ".cargo")),
    cooldownDays: Number(rawDays),
    now: dependencies.now ?? Date.now(),
    verbose: verboseInput === "true",
  }, dependencies);
  setOutputs(result.stats, dependencies.outputPath);
  console.log(`Cargo cooldown evidence: ${result.stats.checkedPackages} package(s) checked across ${result.stats.uniqueCrates} crate(s); ${result.stats.cacheHits} cache hit(s), ${result.stats.remoteFallbacks} remote fallback(s), ${result.stats.exemptions} exemption(s).`);
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      annotation(`${violation.key} was published ${violation.rawTime}; it is not eligible until ${new Date(violation.eligibleAt).toISOString()} (${violation.days}-day cooldown)`);
    }
    throw new Error(`${result.violations.length} crates.io package(s) violate the cooldown policy`);
  }
  console.log(`Cargo cooldown passed for ${result.stats.checkedPackages} checked crates.io package(s).`);
}

if (require.main === module) {
  main().catch((error) => {
    annotation(`Cargo cooldown could not prove that the crates.io versions recorded in Cargo.lock satisfy policy; failing closed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  checkPackages,
  classifyPackages,
  crateIndexPath,
  main,
  parseAllowlist,
  parseCargoLock,
  publicationTimes,
  readCachedPublicationTimes,
  requestIndex,
  sparseCachePublicationTimes,
};
