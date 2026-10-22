const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_BROKER_HOST,
  brokerAudience,
  brokerEndpoint,
  brokerHost,
} = require("./endpoint.cjs");
const { brokerFailureMessage } = require("./error.cjs");

test("selects the broker endpoint and OIDC audience for the host", () => {
  for (const [host, endpoint, audience] of [
    ["", "https://cf-deployer.tempoxyz.net/", "cf-deployer.tempoxyz.net"],
    ["broker.example.com", "https://broker.example.com/", "broker.example.com"],
  ]) {
    assert.equal(brokerEndpoint(host).href, endpoint);
    assert.equal(brokerAudience(host), audience);
  }
});

test("defaults an omitted host and rejects non-hostname values", () => {
  assert.equal(brokerHost(""), DEFAULT_BROKER_HOST);
  for (const host of [
    "https://example.com",
    "example.com:443",
    "example.com/path",
    "UPPER.example.com",
    "localhost",
  ]) {
    assert.throws(() => brokerEndpoint(host), /lowercase DNS hostname/);
    assert.throws(() => brokerAudience(host), /lowercase DNS hostname/);
  }
});

test("exposes only a hostname override with the production default", () => {
  const action = readFileSync(path.join(__dirname, "action.yml"), "utf8");
  const main = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.ok(action.includes("  host:"));
  assert.ok(action.includes('default: "cf-deployer.tempoxyz.net"'));
  assert.ok(action.includes("INPUT_HOST: ${{ inputs.host }}"));
  for (const removed of [
    "  dev:",
    "INPUT_DEV",
    "  endpoint:",
    "INPUT_ENDPOINT",
    "bootstrap-secrets-json",
    "INPUT_BOOTSTRAP_SECRETS_JSON",
  ])
    assert.ok(!action.includes(removed), removed);
  assert.ok(main.includes('new URL("/v1/deploy", endpoint)'));
  assert.ok(main.includes("oidc(audience)"));
  assert.ok(!main.includes("oidc(endpoint.hostname)"));
});

test("identifies every broker failure by operation, status, code, and safe message", () => {
  assert.equal(
    brokerFailureMessage("deployment", 403, {
      error: "artifact_configuration_mismatch",
      message:
        "D1 binding `DB` to database `c733fe15-460a-4b37-b959-c6da4e717a8e` is not authorized\nby policy.",
    }),
    "Cloudflare Deploy Broker deployment failed (HTTP 403) [artifact_configuration_mismatch]: D1 binding `DB` to database `c733fe15-460a-4b37-b959-c6da4e717a8e` is not authorized by policy.",
  );
  assert.equal(
    brokerFailureMessage("cleanup", 502, {}),
    "Cloudflare Deploy Broker cleanup failed (HTTP 502)",
  );
});
