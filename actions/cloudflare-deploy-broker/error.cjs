function brokerFailureDetail(result) {
  const code =
    result !== null &&
    typeof result === "object" &&
    typeof result.error === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(result.error)
      ? ` [${result.error}]`
      : "";
  const message =
    result !== null &&
    typeof result === "object" &&
    typeof result.message === "string"
      ? `: ${result.message.replace(/[\r\n]+/g, " ").slice(0, 1_000)}`
      : "";
  return `${code}${message}`;
}

function brokerFailureMessage(operation, status, result) {
  return `Cloudflare Deploy Broker ${operation} failed (HTTP ${status})${brokerFailureDetail(result)}`;
}

module.exports = { brokerFailureDetail, brokerFailureMessage };
