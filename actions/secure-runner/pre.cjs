const hardenRunner = require("../harden-runner/pre.cjs");
const { exchangeToken: exchangeStepSecurityToken } = require("../step-security-sts/main.cjs");
const { createOidcClient } = require("./oidc.cjs");

// Job start: Harden Runner must be running before checkout, so it starts here
// exactly as the standalone harden-runner action does. The Step Security STS
// exchange takes its OIDC assertion from the shared client.
async function main({
  env = process.env,
  run,
  oidc = createOidcClient({ env }),
  exchangeToken = exchangeStepSecurityToken,
} = {}) {
  await hardenRunner.main({
    env,
    run,
    exchange: (host) =>
      exchangeToken(host, { env, getOidc: (audience) => oidc.token(audience) }),
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
