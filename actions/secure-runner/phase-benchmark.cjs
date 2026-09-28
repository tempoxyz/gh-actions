const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const main = require("./main.cjs");
const timing = require("./phase-timing.cjs");
const { createOidcClient } = require("./oidc.cjs");
const { request: oidcRequest } = require("../step-security-sts/http.cjs");
const { request: socketRequest } = require("../socket-sts/http.cjs");
const { exchange } = require("../socket-sts/main.cjs");
const { installAegis } = require("../aegis/install.cjs");

async function benchmark() {
  const oidc = createOidcClient({ request: (url, ...args) => {
    const audience = new URL(url).searchParams.get("audience");
    return timing.timed(audience === "https://aegis.tempoxyz.net" ? "release_oidc_http" : "socket_oidc_http",
      () => oidcRequest(url, ...args));
  } });
  await timing.timed("setup_total", () => main.main({ deps: {
    oidc,
    exchangeSocket: (options) => timing.timed("socket_auth_stage", () => exchange({ ...options,
      request: (url, ...args) => timing.timed(new URL(url).pathname.endsWith("/status") ? "socket_status_http" : "socket_exchange_http",
        () => socketRequest(url, ...args)),
    })),
    ensureCli: (options) => timing.timed("github_cli", () => main.ensureGitHubCli(options)),
    install: (options) => timing.timed("install", () => installAegis(options)),
  } }));
  const result = { events: timing.events };
  console.log(`AEGIS_PHASE_BENCHMARK ${JSON.stringify(result)}`);
  fs.writeFileSync(path.join(process.env.RUNNER_TEMP, "aegis-phases.json"), JSON.stringify(result, null, 2));
  if (!timing.events.some((event) => event.name === "attestation_verify")) throw new Error("Verification did not complete");
  const check = spawnSync("sudo", ["systemctl", "is-active", "--quiet", "agent.service", "aegis.service", "aegis-relay.socket", "aegis-nft.service"], { stdio: "inherit" });
  if (check.status !== 0) throw new Error("Security services are not active");
}
benchmark().catch((error) => { console.error(error); process.exitCode = 1; });
