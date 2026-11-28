const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { exchange } = require("./main.cjs");

const jwt = "header.payload.signature";
const token = "dckr_oat_synthetic";
const ok = (body) => ({ status: 200, body: JSON.stringify(body) });

function setup(t, responses, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "docker-sts-action-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  writeFileSync(output, "");

  const env = {
    DOCKER_STS_POLICY: "publish-image",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?api-version=2.0&audience=old",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    GITHUB_OUTPUT: output,
    ...overrides,
  };
  const calls = [];
  const masks = [];
  const send = async (url, options) => {
    calls.push({ url: url.href, ...options });
    return responses[calls.length - 1];
  };

  return {
    run: () => exchange(env, send, (mask) => masks.push(mask)),
    calls,
    masks,
    output: () => readFileSync(output, "utf8"),
  };
}

test("requests the Docker STS audience and publishes only the masked OAT", async (t) => {
  const action = setup(t, [ok({ value: jwt }), ok({ token, username: "tempoxyz" })]);

  await action.run();
  assert.deepEqual(action.calls, [
    {
      url: "https://oidc.example/token?api-version=2.0&audience=dkr-sts.tempoxyz.org",
      headers: { authorization: "Bearer request-token" },
    },
    {
      url: "https://dkr-sts.tempoxyz.org/sts/exchange?identity=publish-image&ttl=15m",
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs: 60_000,
    },
  ]);
  assert.deepEqual(action.masks, [`::add-mask::${jwt}`, `::add-mask::${token}`]);
  assert.equal(action.output(), `token=${token}\n`);
});

test("passes the requested TTL", async (t) => {
  const action = setup(t, [ok({ value: jwt }), ok({ token })], { DOCKER_STS_TTL: "5m" });

  await action.run();
  assert.equal(new URL(action.calls[1].url).searchParams.get("ttl"), "5m");
});

for (const [name, overrides, error] of [
  ["malformed policy", { DOCKER_STS_POLICY: "a&ttl=60m" }, /policy/],
  ["out-of-range TTL", { DOCKER_STS_TTL: "61m" }, /ttl/],
  ["missing OIDC permission", { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, /id-token: write/],
  ["insecure OIDC endpoint", { ACTIONS_ID_TOKEN_REQUEST_URL: "http://oidc.example" }, /URL is invalid/],
]) {
  test(`rejects ${name} before making a request`, async (t) => {
    const action = setup(t, [], overrides);

    await assert.rejects(action.run(), error);
    assert.equal(action.calls.length, 0);
    assert.equal(action.output(), "");
  });
}

test("rejects a malformed OIDC token before exchange", async (t) => {
  const action = setup(t, [ok({ value: "invalid" })]);

  await assert.rejects(action.run(), /valid token/);
  assert.equal(action.calls.length, 1);
  assert.deepEqual(action.masks, []);
});

test("reports an STS refusal without logging its body or repeating the mint", async (t) => {
  const action = setup(t, [ok({ value: jwt }), { status: 503, body: "sensitive upstream text" }]);

  await assert.rejects(action.run(), { message: "Docker STS exchange failed (HTTP 503)" });
  assert.equal(action.calls.length, 2);
  assert.equal(action.output(), "");
});

test("rejects an unsafe output without emitting a workflow command", async (t) => {
  const action = setup(t, [ok({ value: jwt }), ok({ token: token + "\nother=unsafe" })]);

  await assert.rejects(action.run(), /valid Docker Hub token/);
  assert.deepEqual(action.masks, [`::add-mask::${jwt}`]);
  assert.equal(action.output(), "");
});
