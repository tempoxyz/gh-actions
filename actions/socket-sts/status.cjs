const fs = require("node:fs");
const { REQUEST_TIMEOUT_MS, request: httpRequest } = require("./http.cjs");

const SERVICE = "Socket STS";
const USER_AGENT = "tempoxyz-socket-sts-action";
// Shared across the STS actions, so a caller composing several of them can
// recognize a disabled service from any of them without importing each class.
const DISABLED_CODE = "ESTS_SERVICE_DISABLED";
const MAX_REASON_LENGTH = 200;

// Thrown when the STS reports that it is not serving exchanges, so the caller
// can say why instead of retrying against it for the rest of its budget.
class ServiceDisabledError extends Error {
  constructor(service, host, reason) {
    super(`${service} at ${host} is disabled: ${reason}`);
    this.name = "ServiceDisabledError";
    this.code = DISABLED_CODE;
    this.service = service;
    this.host = host;
    this.reason = reason;
  }
}

function isServiceDisabled(error) {
  return error?.code === DISABLED_CODE;
}

// One line of printable text, so the reason reads cleanly in an annotation.
function reasonText(value) {
  if (typeof value !== "string") return "no reason given";
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? "no reason given" : text.slice(0, MAX_REASON_LENGTH);
}

// Parses a status response body: {"status":"enabled"} or
// {"status":"disabled","reason":"Paused"}. Anything else is unrecognized.
function parseStatus(body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  if (value.status === "enabled") return { status: "enabled" };
  if (value.status === "disabled") {
    return { status: "disabled", reason: reasonText(value.reason) };
  }
  return null;
}

// Asks the STS whether it is serving exchanges with one POST /status. Any
// other answer, or none, is inconclusive: the caller proceeds to the exchange,
// which reports its own failures. The request is bounded by the usual request
// timeout and by whatever is left of the caller's budget.
async function serviceStatus(
  origin,
  { request = httpRequest, now = Date.now, deadline = Infinity, userAgent = USER_AGENT } = {},
) {
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - now());
  if (!(timeoutMs > 0)) return null;
  const inconclusive = (why) => {
    console.log(`${SERVICE} status check was inconclusive (${why}); continuing with the exchange.`);
    return null;
  };
  let response;
  try {
    response = await request(`${origin}/status`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-length": "0",
        "user-agent": userAgent,
      },
      timeoutMs,
    });
  } catch (error) {
    return inconclusive(error.message);
  }
  if (response.status !== 200) return inconclusive(`HTTP ${response.status}`);
  const status = parseStatus(response.body);
  return status === null ? inconclusive("unrecognized response") : status;
}

// Throws ServiceDisabledError when the STS at `host` reports itself disabled.
async function requireServiceEnabled(host, options = {}) {
  const status = await serviceStatus(`https://${host}`, options);
  if (status?.status === "disabled") {
    throw new ServiceDisabledError(SERVICE, host, status.reason);
  }
}

// The annotation text for a disabled STS: what is disabled, why, and what
// that means for this job.
function disabledMessage(error, consequence) {
  return `The ${error.service} at ${error.host} is disabled: ${error.reason}. ${consequence}`;
}

function escapeAnnotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

// Emits the warning annotation for a disabled STS and mirrors it into the
// job's step summary when GitHub provides one.
function disabledWarning(error, consequence, env = process.env) {
  const title = `${error.service} disabled`;
  const message = disabledMessage(error, consequence);
  const property = escapeAnnotation(title).replaceAll(":", "%3A").replaceAll(",", "%2C");
  console.log(`::warning title=${property}::${escapeAnnotation(message)}`);
  const summary = env?.GITHUB_STEP_SUMMARY;
  if (typeof summary === "string" && summary !== "") {
    fs.appendFileSync(summary, `> ⚠️ **${title}:** ${message}\n`);
  }
}

module.exports = {
  DISABLED_CODE,
  SERVICE,
  ServiceDisabledError,
  disabledMessage,
  disabledWarning,
  isServiceDisabled,
  parseStatus,
  requireServiceEnabled,
  serviceStatus,
};
