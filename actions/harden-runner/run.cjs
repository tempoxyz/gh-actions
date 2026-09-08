const path = require("node:path");
const { spawnSync } = require("node:child_process");

const entrypoints = {
  pre: "dist/pre/index.js",
  main: "dist/index.js",
  post: "dist/post/index.js",
};

function hardenRunnerEnv(token, env = process.env) {
  if (!/^\S{20,4096}$/.test(token)) {
    throw new Error("stored Step Security API key is invalid");
  }
  return {
    ...env,
    "INPUT_API-KEY": token,
    "INPUT_DISABLE-SUDO": "false",
    "INPUT_USE-POLICY-STORE": "true",
  };
}

function runHardenRunner(phase, token) {
  const relative = entrypoints[phase];
  if (!relative) throw new Error(`invalid Harden Runner phase: ${phase}`);
  const script = path.join(
    __dirname,
    "../../vendor/step-security/harden-runner",
    relative,
  );
  const result = spawnSync(process.execPath, [script], {
    // Keep the API key scoped to Harden Runner instead of exporting it to the
    // environment inherited by later workflow steps.
    env: hardenRunnerEnv(token),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Harden Runner ${phase} failed (exit ${result.status})`);
  }
}

module.exports = { hardenRunnerEnv, runHardenRunner };
