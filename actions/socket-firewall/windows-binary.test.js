const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureWindowsExecutable } = require("./windows-binary.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socket firewall "));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "sfw");
}

test("copies verified bytes without removing the upstream path, refreshing stale copies", (t) => {
  const binary = fixture(t);
  fs.writeFileSync(binary, "verified binary");
  fs.writeFileSync(`${binary}.exe`, "stale binary");
  assert.equal(ensureWindowsExecutable(binary), `${binary}.exe`);
  assert.deepEqual(fs.readFileSync(`${binary}.exe`), fs.readFileSync(binary));
});

test("accepts an upstream executable that already has the Windows extension", (t) => {
  const binary = `${fixture(t)}.exe`;
  fs.writeFileSync(binary, "verified binary");
  assert.equal(ensureWindowsExecutable(binary), binary);
  assert.equal(fs.existsSync(`${binary}.exe`), false);
});

test("fails on missing binaries and unsafe output paths", (t) => {
  assert.throws(() => ensureWindowsExecutable(fixture(t)), /ENOENT/);
  for (const binary of [undefined, "sfw", `${fixture(t)}\npath=injected`]) {
    assert.throws(() => ensureWindowsExecutable(binary), /absolute, single-line/);
  }
});

test("Windows cmd shim resolves an extensionless target in a path with spaces", {
  skip: process.platform !== "win32",
}, (t) => {
  const binary = fixture(t);
  fs.copyFileSync(process.execPath, binary);
  const shim = path.join(path.dirname(binary), "cargo.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"${binary}" --version\r\n`);
  const runShim = () => spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "cargo.cmd"], {
    cwd: path.dirname(binary), encoding: "utf8",
  });
  assert.notEqual(runShim().status, 0, "extensionless PE binary reproduces the failure");
  ensureWindowsExecutable(binary);
  const result = runShim();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), process.version);
});
