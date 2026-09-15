const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGES = {
  allow: "isnumber@1.0.0",
  block: "lodahs@0.0.1-security",
};

function npmCLI(node = process.execPath) {
  const directory = path.dirname(node);
  const candidates = process.platform === "win32"
    ? [path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")]
    : [
        path.join(directory, "npm"),
        path.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
      ];
  const candidate = candidates.find((value) => fs.existsSync(value));
  const cli = candidate && fs.realpathSync(candidate);
  if (!cli) throw new Error(`Could not find npm next to ${node}`);
  return cli;
}

function main() {
  const name = process.argv[2];
  const packageName = PACKAGES[name];
  if (!packageName) throw new Error("Expected allow or block");
  const temporary = process.env.RUNNER_TEMP || os.tmpdir();
  const workingDirectory = path.join(temporary, `aegis-${name}`);
  const cache = path.join(temporary, `aegis-npm-cache-${name}`);
  fs.mkdirSync(workingDirectory, { recursive: true });
  const result = spawnSync(process.execPath, [
    npmCLI(), "install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--cache", cache, packageName,
  ], { cwd: workingDirectory, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { PACKAGES, npmCLI };
