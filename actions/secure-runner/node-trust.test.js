const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { bundlePath, exportNodeTrust } = require("./node-trust.cjs");

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-node-trust-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, "aegis.pem");
  fs.writeFileSync(bundle, "aegis certificates\n");
  return { directory, bundle, env: { GITHUB_ENV: path.join(directory, "env"), RUNNER_TEMP: directory } };
}

test("selects the installed bundle on each supported platform", () => {
  assert.equal(bundlePath("linux", {}), "/etc/aegis/bundle.pem");
  assert.equal(bundlePath("darwin", {}), "/Library/Application Support/Aegis/bundle.pem");
  assert.equal(bundlePath("win32", {}), "C:\\ProgramData\\Aegis\\bundle.pem");
  assert.equal(bundlePath("win32", { ProgramData: "D:\\Program Data" }), "D:\\Program Data\\Aegis\\bundle.pem");
  assert.throws(() => bundlePath("plan9", {}), /Unsupported platform/);
});

test("exports the installed bundle for later steps without changing current-process trust", (context) => {
  const { bundle, env } = fixture(context);
  assert.equal(exportNodeTrust({ bundle, env }), bundle);
  assert.equal(fs.readFileSync(env.GITHUB_ENV, "utf8"), `NODE_EXTRA_CA_CERTS=${bundle}\n`);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
});

test("preserves existing extra certificates in a private combined bundle", (context) => {
  const { directory, bundle, env } = fixture(context);
  env.NODE_EXTRA_CA_CERTS = path.join(directory, "existing.pem");
  fs.writeFileSync(env.NODE_EXTRA_CA_CERTS, "existing certificates");
  const exported = exportNodeTrust({ bundle, env });
  assert.equal(fs.readFileSync(exported, "utf8"), "existing certificates\naegis certificates\n");
  assert.equal(fs.readFileSync(env.NODE_EXTRA_CA_CERTS, "utf8"), "existing certificates");
  assert.equal(fs.readFileSync(env.GITHUB_ENV, "utf8"), `NODE_EXTRA_CA_CERTS=${exported}\n`);
  if (process.platform !== "win32") assert.equal(fs.statSync(exported).mode & 0o777, 0o600);
});

test("does not duplicate an already configured Aegis bundle", (context) => {
  const { directory, bundle, env } = fixture(context);
  env.NODE_EXTRA_CA_CERTS = bundle;
  assert.equal(exportNodeTrust({ bundle, env }), bundle);
  assert.deepEqual(fs.readdirSync(directory).sort(), ["aegis.pem", "env"]);
});

test("fails without writing environment entries when trust files are unavailable", (context) => {
  const { directory, bundle, env } = fixture(context);
  assert.throws(() => exportNodeTrust({ bundle, env: {} }), /GITHUB_ENV is missing/);
  assert.throws(() => exportNodeTrust({ bundle: path.join(directory, "missing.pem"), env }), /ENOENT/);
  env.NODE_EXTRA_CA_CERTS = path.join(directory, "missing-extra.pem");
  assert.throws(() => exportNodeTrust({ bundle, env }), /ENOENT/);
  assert.equal(fs.existsSync(env.GITHUB_ENV), false);
});

test("rejects newlines in the exported path", (context) => {
  const { directory, env } = fixture(context);
  const bundle = path.join(directory, "bundle\nNODE_TLS_REJECT_UNAUTHORIZED=0");
  fs.writeFileSync(bundle, "certificates");
  assert.throws(() => exportNodeTrust({ bundle, env }), /contains a newline/);
  assert.equal(fs.existsSync(env.GITHUB_ENV), false);
});

function childRequest(url, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", `fetch(${JSON.stringify(url)}, {method: 'POST', body: ''}).then(response => console.log(response.status)).catch(error => { console.log(error.cause?.code); process.exitCode = 1; });`], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr }));
  });
}

test("Node fetch rejects a registry TLS chain despite npm cafile, then trusts the exported bundle", { timeout: 30_000 }, async (context) => {
  const { directory, bundle, env } = fixture(context);
  function openssl(args) {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Aegis test CA", "-keyout", "ca.key", "-out", bundle]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server.key", "-out", "server.csr"]);
  fs.writeFileSync(path.join(directory, "extensions"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  openssl(["x509", "-req", "-in", "server.csr", "-CA", bundle, "-CAkey", "ca.key", "-CAcreateserial", "-days", "1", "-extfile", "extensions", "-out", "server.pem"]);
  const methods = [];
  const server = https.createServer({
    key: fs.readFileSync(path.join(directory, "server.key")),
    cert: Buffer.concat([fs.readFileSync(path.join(directory, "server.pem")), fs.readFileSync(bundle)]),
  }, (request, response) => {
    methods.push(request.method);
    response.writeHead(401);
    response.end("fixture: no real npm credentials");
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}/-/npm/v1/oidc/token/exchange/package/aegis-fixture`;
  fs.writeFileSync(path.join(directory, ".npmrc"), `cafile=${bundle}\n`);
  const childEnv = { ...process.env };
  for (const name of ["NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_USE_SYSTEM_CA", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY"]) delete childEnv[name];
  const before = await childRequest(url, childEnv, directory);
  assert.equal(before.status, 1, before.stderr);
  assert.equal(before.stdout, "SELF_SIGNED_CERT_IN_CHAIN");
  assert.deepEqual(methods, []);
  exportNodeTrust({ bundle, env });
  const exported = fs.readFileSync(env.GITHUB_ENV, "utf8").trim().slice("NODE_EXTRA_CA_CERTS=".length);
  const after = await childRequest(url, { ...childEnv, NODE_EXTRA_CA_CERTS: exported }, directory);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, "401");
  assert.deepEqual(methods, ["POST"]);
});
