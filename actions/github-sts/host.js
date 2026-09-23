function host(value) {
  if (
    typeof value === "string" &&
    value.length <= 253 &&
    value
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      )
  ) {
    return value;
  }
  throw new Error("host must be a hostname without a scheme, port, or path");
}

module.exports = { host };
