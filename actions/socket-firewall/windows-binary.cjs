const fs = require("node:fs");
const path = require("node:path");

function ensureWindowsExecutable(binary) {
  if (!binary || !path.isAbsolute(binary) || /[\r\n]/.test(binary)) {
    throw new Error("Socket Firewall binary path must be an absolute, single-line path");
  }
  // The pinned upstream installer caches the verified PE binary as `sfw`.
  // cmd.exe needs an executable extension. Keep the original for upstream
  // consumers and add sfw.exe so its extensionless .cmd shim target resolves.
  if (/\.exe$/i.test(binary)) {
    fs.accessSync(binary);
    return binary;
  }
  const executable = `${binary}.exe`;
  fs.copyFileSync(binary, executable);
  return executable;
}

if (require.main === module) {
  try {
    const executable = ensureWindowsExecutable(process.env.FIREWALL_PATH_BINARY);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${executable}\n`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { ensureWindowsExecutable };
