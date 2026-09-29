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
          if (args[1] === "trusted-root") fs.writeSync(options.stdio[1], "trusted roots\n");
          else verified = true;
        },
        sleep: async () => {},
      });
      assert.equal(fs.readFileSync(result.package, "utf8"), "artifact");
      assert.equal(verified, true, "must await provenance verification before returning the artifact");
      assert.equal(requests.some(({ url }) => url.includes("/next?")), requested === "");
      assert.equal(requests[requested === "" ? 1 : 0].url,
        `https://aegis.tempoxyz.net/v1/actions/releases/${channel}/${tag}`);
      assert.ok(requests.every(({ options }) => options.headers["x-aegis-github-oidc-jwt"] === "oidc-assertion"));
      assert.equal(commands.length, 2);
      assert.equal(commands[0].command, "gh");
      assert.equal(commands[0].options.env.GH_TOKEN, "job-token");
      assert.deepEqual(commands[0].args, ["attestation", "trusted-root"]);
      const rootIndex = commands[1].args.indexOf("--custom-trusted-root");
      assert.ok(rootIndex > 0);
      assert.equal(fs.readFileSync(commands[1].args[rootIndex + 1], "utf8"), "trusted roots\n");
      assert.deepEqual(commands[1].args.slice(-5), ["--source-digest", "a".repeat(40),
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

function fixture(t, { fetcher, execute } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-parallel-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const asset = "aegis-0.19.0-linux-amd64.deb";
  const digest = crypto.createHash("sha256").update("artifact").digest("hex");
  const response = (url) => {
    if (url.endsWith("/v0.19.0")) return Response.json({ tag: "v0.19.0", version: "0.19.0",
      channel: "regular", prerelease: false, source_commit: "a".repeat(40) });
    if (url.endsWith(asset)) return new Response("artifact");
    if (url.endsWith("SHA256SUMS")) return new Response(`${digest}  ${asset}\n`);
    return new Response("{}");
  };
  return {
    version: "v0.19.0", runnerOS: "Linux", runnerArch: "X64",
    env: { RUNNER_TEMP: directory }, getOidc: async () => "assertion", sleep: async () => {},
    fetcher: (url) => fetcher ? fetcher(url, response) : response(url),
    execute: async (command, args, options) => {
      if (execute) return execute(args, options);
      if (args[1] === "trusted-root") fs.writeSync(options.stdio[1], "roots\n");
    },
  };
}

test("all three transfers overlap roots and verification waits for every completed body", async (t) => {
  const started = new Set();
  const allStarted = Promise.withResolvers();
  const rootsDone = Promise.withResolvers();
  const bodyDone = Promise.withResolvers();
  let verified = false;
  const start = (name) => { started.add(name); if (started.size === 4) allStarted.resolve(); };
  const running = downloadAndVerify(fixture(t, {
    fetcher: async (url, response) => {
      if (!url.includes("/assets/")) return response(url);
      start(url.split("/").at(-1));
      await allStarted.promise;
      const bytes = await response(url).arrayBuffer();
      return new Response(new ReadableStream({ async start(controller) {
        await bodyDone.promise;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      } }));
    },
    execute: async (args, options) => {
      if (args[1] === "trusted-root") {
        start("roots");
        await rootsDone.promise;
        fs.writeSync(options.stdio[1], "roots\n");
      } else { verified = true; }
    },
  }));
  await allStarted.promise;
  rootsDone.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(verified, false, "headers alone are not completed downloads");
  bodyDone.resolve();
  await running;
  assert.equal(verified, true);
});

test("root and asset failures drain their peers and never verify", async (t) => {
  for (const failure of ["roots", "asset"]) {
    const release = Promise.withResolvers();
    const failed = Promise.withResolvers();
    let finished = false;
    let attempts = 0;
    const running = downloadAndVerify(fixture(t, {
      fetcher: async (url, response) => {
        if (!url.includes("/assets/")) return response(url);
        if (failure === "asset" && url.endsWith("SHA256SUMS")) {
          if (++attempts === 3) failed.resolve();
          throw new Error("asset failed");
        }
        await release.promise;
        return response(url);
      },
      execute: async (args, options) => {
        assert.equal(args[1], "trusted-root", "must not verify after preparation fails");
        if (failure === "roots") {
          if (++attempts === 3) failed.resolve();
          throw new Error("roots failed");
        }
        await release.promise;
        fs.writeSync(options.stdio[1], "roots\n");
      },
    })).then(() => assert.fail("must fail"), (error) => { finished = true; return error; });
    await failed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    release.resolve();
    assert.match((await running).message, new RegExp(`${failure} failed`));
    assert.equal(attempts, 3);
  }
});

test("root retries discard partial output, close descriptors, and preserve verification constraints", async (t) => {
  let attempts = 0;
  const descriptors = [];
  await downloadAndVerify(fixture(t, { execute: async (args, options) => {
    if (args[1] === "trusted-root") {
      descriptors.push(options.stdio[1]);
      if (++attempts === 1) {
        fs.writeSync(options.stdio[1], "partial invalid roots");
        throw new Error("interrupted");
      }
      fs.writeSync(options.stdio[1], "roots\n");
    } else {
      assert.equal(fs.readFileSync(args[args.indexOf("--custom-trusted-root") + 1], "utf8"), "roots\n");
      assert.ok(args.includes("--deny-self-hosted-runners"));
      assert.equal(args[args.indexOf("--signer-workflow") + 1], "tempoxyz/aegis/.github/workflows/release.yml");
      assert.equal(options.timeout, 60_000);
    }
  } }));
  assert.equal(attempts, 2);
  for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});

test("empty roots, checksum mismatches, and rejected provenance never return an artifact", async (t) => {
  for (const failure of ["empty roots", "checksum", "provenance"]) {
    let verifications = 0;
    await assert.rejects(downloadAndVerify(fixture(t, {
      fetcher: (url, response) => failure === "checksum" && url.endsWith(".deb") ? new Response("tampered") : response(url),
      execute: async (args, options) => {
        if (args[1] === "trusted-root") {
          if (failure !== "empty roots") fs.writeSync(options.stdio[1], "roots\n");
        } else {
          verifications += 1;
          throw new Error("provenance rejected");
        }
      },
    })), /no trusted roots|does not match SHA256SUMS|provenance rejected/);
    assert.equal(verifications, failure === "provenance" ? 3 : 0);
  }
});
