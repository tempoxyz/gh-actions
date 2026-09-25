function escapeAnnotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function warning(message, title) {
  const properties =
    title === undefined
      ? ""
      : ` title=${escapeAnnotation(title).replaceAll(":", "%3A").replaceAll(",", "%2C")}`;
  console.log(`::warning${properties}::${escapeAnnotation(message)}`);
}

module.exports = { escapeAnnotation, warning };
