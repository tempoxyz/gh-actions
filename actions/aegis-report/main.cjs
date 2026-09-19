const fs = require("node:fs");

function append(file, name, value) {
  if (typeof value !== "string" || /\r|\n/.test(value))
    throw new Error(`${name} is invalid`);
  fs.appendFileSync(file, `${name}=${value}\n`);
}

function main() {
  const state = process.env.GITHUB_STATE;
  if (!state) throw new Error("GITHUB_STATE is missing");
  append(state, "action", "aegis-report");
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
