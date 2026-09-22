function validateHost(host) {
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    !host
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  ) {
    throw new Error("host must be a hostname without a scheme, port, or path");
  }
  return host;
}

module.exports = { validateHost };
