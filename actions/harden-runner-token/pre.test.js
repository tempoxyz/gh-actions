const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AUDIENCE, TOKEN_URL } = require("../harden-runner/mint.cjs");
const {
  ENVIRONMENT_VARIABLE,
  main,
} = require("./pre.cjs");

test("action metadata registers token minting as a pre entrypoint", () => {
  const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");
  assert.match(manifest, /using: "node24"/);
  assert.match(manifest, /pre: "pre\.cjs"/);
  assert.match(manifest, /main: "main\.cjs"/);
});

test("pre entrypoint mints, masks, and exports the policy-store token", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "harden-runner-token-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environmentFile = path.join(directory, "environment");
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.actions.example/token?job=1",
    GITHUB_ENV: environmentFile,
  };
  const calls = [];
  const logs = [];

  await main({
    environment,
    log: (value) => logs.push(value),
    async fetchImpl(url, options) {
      calls.push([url.toString(), options]);
      if (calls.length === 1) {
        return {
          ok: true,
          async json() {
            return { value: "github-oidc-token" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { token: "stepsecurity-api-token" };
        },
      };
    },
  });

  assert.equal(
    calls[0][0],
    `https://oidc.actions.example/token?job=1&audience=${AUDIENCE}`,
  );
  assert.equal(calls[0][1].headers.Authorization, "Bearer github-request-token");
  assert.equal(calls[1][0], TOKEN_URL);
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    github_oidc_token: "github-oidc-token",
  });
  assert.deepEqual(logs, ["::add-mask::stepsecurity-api-token"]);
  assert.equal(
    fs.readFileSync(environmentFile, "utf8"),
    `${ENVIRONMENT_VARIABLE}=stepsecurity-api-token\n`,
  );
});

test("pre entrypoint fails closed without id-token permission", async () => {
  await assert.rejects(
    main({
      environment: {
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        GITHUB_ENV: "unused",
      },
      async fetchImpl() {
        throw new Error("fetch must not run");
      },
    }),
    /ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing/,
  );
});
