const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { downloadAndVerify, retry } = require("./aegis-release.cjs");

for (const [requested, tag, version, channel] of [
  ["", "v0.15.0", "0.15.0", "regular"],
  ["v0.15.0", "v0.15.0", "0.15.0", "regular"],
  ["20260927T194115Z-5e7bd8b807b2", "20260927T194115Z-5e7bd8b807b2", "5e7bd8b807b2", "pre-release"],
]) {
  test(`downloads and verifies ${requested || "latest stable"} from the Aegis server`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-server-download-test-"));
    const asset = `aegis-${version}-linux-amd64.deb`;
    const digest = crypto.createHash("sha256").update("artifact").digest("hex");
    const requests = [];
    const commands = [];
    let verified = false;
    const fetcher = async (url, options) => {
      requests.push({ url, options });
      if (url.includes("/next?")) return Response.json({ tag });
      if (url.endsWith(`/${tag}`)) return Response.json({ tag, version, channel,
        prerelease: channel === "pre-release", source_commit: "a".repeat(40) });
      if (url.endsWith(`/${asset}`)) return new Response("artifact");
      if (url.endsWith("/SHA256SUMS")) return new Response(`${digest}  ${asset}\n`);
      if (url.endsWith("/provenance.sigstore.json")) return new Response("{}");
      return new Response("missing", { status: 404 });
    };
    try {
      const result = await downloadAndVerify({
        version: requested,
        getOidc: async (audience) => { assert.equal(audience, "https://aegis.tempoxyz.net"); return "oidc-assertion"; },
        token: "job-token",
        runnerOS: "Linux", runnerArch: "X64",
        env: { RUNNER_TEMP: directory, PATH: "/usr/bin" },
        fetcher,
        execute: async (command, args, options) => {
          commands.push({ command, args, options });
          await new Promise((resolve) => setImmediate(resolve));
          verified = true;
        },
        sleep: async () => {},
      });
      assert.equal(fs.readFileSync(result.package, "utf8"), "artifact");
      assert.equal(verified, true, "must await provenance verification before returning the artifact");
      assert.equal(requests.some(({ url }) => url.includes("/next?")), requested === "");
      assert.equal(requests[requested === "" ? 1 : 0].url,
        `https://aegis.tempoxyz.net/v1/actions/releases/${channel}/${tag}`);
      assert.ok(requests.every(({ options }) => options.headers["x-aegis-github-oidc-jwt"] === "oidc-assertion"));
      assert.equal(commands.length, 1);
      assert.equal(commands[0].command, "gh");
      assert.equal(commands[0].options.env.GH_TOKEN, "job-token");
      assert.deepEqual(commands[0].args.slice(-5), ["--source-digest", "a".repeat(40),
        "--source-ref", "refs/heads/main", "--deny-self-hosted-runners"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("rejects invalid versions before calling the server", async () => {
  await assert.rejects(downloadAndVerify({ version: "../latest", getOidc: async () => "x" }), /Invalid Aegis release version/);
});

test("async command failures retry with bounded jitter and reject after three attempts", async () => {
  let attempts = 0;
  const waits = [];
  await assert.rejects(retry(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    attempts += 1;
    throw new Error("verification failed");
  }, "verification", async (ms) => waits.push(ms), 0.25), /verification failed/);
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 1000 && waits[0] <= 1250);
  assert.ok(waits[1] >= 2000 && waits[1] <= 2500);
});
