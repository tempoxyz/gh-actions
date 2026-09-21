const fs = require("node:fs");
const { identity, retire } = require("./linux-lifecycle.cjs");

function append(file, name, value) {
  if (typeof value !== "string" || /\r|\n/.test(value))
    throw new Error(`${name} is invalid`);
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function main() {
  const state = process.env.GITHUB_STATE;
  if (!state) throw new Error("GITHUB_STATE is missing");
  append(state, "action", "aegis-report");
  const config = process.env["INPUT_LINUX-INSTALLATION-CONFIG"];
  if (config && process.platform === "linux") {
    const owner = identity(JSON.parse(fs.readFileSync(config, "utf8")));
    // Use the incumbent binary before the package upgrade. Arm post cleanup only
    // after restoration succeeds, so failed restoration retains recovery state.
    retire();
    append(state, "installation_identity", owner);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { main };
