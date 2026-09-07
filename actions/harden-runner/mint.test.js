const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AUDIENCE,
  TOKEN_URL,
  mintStepSecurityToken,
} = require("./mint.cjs");

function makeCore() {
  const calls = {
    audiences: [],
    outputs: [],
    secrets: [],
  };

  return {
    calls,
    core: {
      async getIDToken(audience) {
        calls.audiences.push(audience);
        return "github-oidc-token";
      },
      setOutput(name, value) {
        calls.outputs.push([name, value]);
      },
      setSecret(value) {
        calls.secrets.push(value);
      },
    },
  };
}

test("mints, masks, and outputs a StepSecurity token", async () => {
  const { calls, core } = makeCore();
  const requests = [];

  await mintStepSecurityToken({
    core,
    async fetchImpl(url, options) {
      requests.push([url, options]);
      return {
        ok: true,
        async json() {
          return { token: "stepsecurity-api-token" };
        },
      };
    },
  });

  assert.deepEqual(calls.audiences, [AUDIENCE]);
  assert.deepEqual(requests, [
    [
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ github_oidc_token: "github-oidc-token" }),
      },
    ],
  ]);
  assert.deepEqual(calls.secrets, ["stepsecurity-api-token"]);
  assert.deepEqual(calls.outputs, [["token", "stepsecurity-api-token"]]);
});

test("rejects a failed token exchange without exposing a token", async () => {
  const { calls, core } = makeCore();

  await assert.rejects(
    mintStepSecurityToken({
      core,
      async fetchImpl() {
        return { ok: false, status: 403 };
      },
    }),
    /StepSecurity token exchange failed: 403/,
  );

  assert.deepEqual(calls.secrets, []);
  assert.deepEqual(calls.outputs, []);
});

test("rejects a successful response without a token", async () => {
  const { calls, core } = makeCore();

  await assert.rejects(
    mintStepSecurityToken({
      core,
      async fetchImpl() {
        return {
          ok: true,
          async json() {
            return { token: "" };
          },
        };
      },
    }),
    /StepSecurity token exchange returned no token/,
  );

  assert.deepEqual(calls.secrets, []);
  assert.deepEqual(calls.outputs, []);
});
