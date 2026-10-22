const https = require("node:https");

const CONNECTION_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function request(url, options = {}, body = undefined, dependencies = {}) {
  const makeRequest = dependencies.httpsRequest ?? https.request;
  const startTimer = dependencies.setTimeout ?? setTimeout;
  const stopTimer = dependencies.clearTimeout ?? clearTimeout;
  const connectionTimeoutMs =
    dependencies.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let connectionTimer;
    const clearConnectionTimer = () => {
      if (connectionTimer !== undefined) {
        stopTimer(connectionTimer);
        connectionTimer = undefined;
      }
    };
    const call = makeRequest(url, options, (response) => {
      clearConnectionTimer();
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
        if (responseBody.length > MAX_RESPONSE_BYTES) {
          call.destroy(new Error("response is too large"));
        }
      });
      response.once("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          body: responseBody,
          retryAfter: firstHeader(response.headers?.["retry-after"]),
        }),
      );
    });
    connectionTimer = startTimer(() => {
      call.destroy(
        new Error(
          `HTTPS connection to ${url.hostname} timed out after ${connectionTimeoutMs / 1_000} seconds`,
        ),
      );
    }, connectionTimeoutMs);
    call.once("socket", (socket) => {
      if (!socket.connecting) {
        clearConnectionTimer();
        return;
      }
      socket.once("secureConnect", clearConnectionTimer);
      socket.once("close", clearConnectionTimer);
      socket.once("error", clearConnectionTimer);
    });
    call.once("error", (error) => {
      clearConnectionTimer();
      reject(error);
    });
    if (body !== undefined) call.write(body);
    call.end();
  });
}

function httpResponseError(operation, response) {
  const error = new Error(`${operation} failed (HTTP ${response.status})`);
  error.status = response.status;
  error.retryAfter = response.retryAfter;
  return error;
}

function permanentRequestError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

module.exports = { httpResponseError, permanentRequestError, request };
