const fs = require("node:fs");
const {
  httpResponseError,
  permanentRequestError,
  request,
} = require("./request.cjs");

// Runner inputs, environment and OIDC tokens, shared by the broker actions.
function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function input(name) {
  const key = name.toUpperCase();
  return (
    process.env[`INPUT_${key}`] ||
    process.env[`INPUT_${key.replaceAll("-", "_")}`] ||
    ""
  );
}

function valid(name, value, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function required(name, pattern) {
  return valid(name, process.env[name] || "", pattern);
}

function requiredInput(name, pattern) {
  return valid(name, input(name), pattern);
}

async function oidc(audience) {
  const token = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN", /^\S+$/);
  const rawUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL", /^https:\/\//);
  const url = new URL(rawUrl);
  url.searchParams.set("audience", audience);
  const response = await request(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status < 200 || response.status >= 300) {
    throw httpResponseError("GitHub OIDC request", response);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw permanentRequestError("GitHub OIDC response was invalid");
  }
  if (typeof parsed.value !== "string")
    throw permanentRequestError("GitHub OIDC response was invalid");
  return parsed.value;
}

module.exports = { input, oidc, output, required, requiredInput, valid };
