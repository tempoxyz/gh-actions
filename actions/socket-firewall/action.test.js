const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("composes the pinned Socket STS and vendored Firewall actions", () => {
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/actions\/socket-firewall\/sts@0f195471b66fe3e39f538383f67bfc0676a3aaa5/,
  );
  assert.match(
    manifest,
    /tempoxyz\/gh-actions\/vendor\/SocketDev\/action@0f195471b66fe3e39f538383f67bfc0676a3aaa5/,
  );
  assert.doesNotMatch(manifest, /^\s+uses:\s+SocketDev\/action@/m);
  assert.match(manifest, /mode: firewall\n/);
  assert.doesNotMatch(manifest, /mode: firewall-(?:enterprise|free)/);
  assert.match(manifest, /dev: \$\{\{ inputs\.dev \}\}/);
  assert.match(manifest, /socket-token: \$\{\{ steps\.socket-token\.outputs\.token \}\}/);
});

test("forwards both Firewall outputs", () => {
  assert.match(
    manifest,
    /value: \$\{\{ steps\.windows-binary\.outputs\.path \|\| steps\.firewall\.outputs\.firewall-path-binary \}\}/,
  );
  assert.match(
    manifest,
    /value: \$\{\{ steps\.firewall\.outputs\.firewall-path-report \}\}/,
  );
});

test("falls back to the Free edition only on pull_request runs without OIDC", () => {
  const steps = manifest.split(/\n    - name: /).slice(1);
  const names = steps.map((step) => step.split("\n", 1)[0]);
  assert.deepEqual(names.slice(0, 3), [
    "Detect GitHub OIDC availability",
    "Exchange GitHub OIDC token for a Socket token",
    "Install Socket Firewall",
  ]);
  const [detect, exchange, install] = steps;
  assert.match(detect, /id: oidc\n/);
  assert.match(detect, /shell: bash\n/);
  assert.doesNotMatch(detect, /\$\{\{/, "the detection script must not interpolate expressions");
  assert.match(detect, /ACTIONS_ID_TOKEN_REQUEST_TOKEN:-/);
  assert.match(detect, /ACTIONS_ID_TOKEN_REQUEST_URL:-/);
  assert.match(detect, /= "pull_request" \]/);
  assert.match(detect, /::warning::.*Socket Firewall Free/);
  assert.match(detect, /::error::ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing[^\n]*\n\s+exit 1/);
  assert.match(exchange, /^\s+if: steps\.oidc\.outputs\.available == 'true'\n/m);
  assert.doesNotMatch(install, /^\s+if:/m, "the install step must run in both modes");
});
