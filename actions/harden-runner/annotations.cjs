const fs = require("node:fs");

function escapeAnnotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

// Appends Markdown to the job's step summary when GitHub provides one. The
// file is per step and absent outside GitHub Actions, so this is a no-op there.
function stepSummary(env, markdown) {
  const file = env?.GITHUB_STEP_SUMMARY;
  if (typeof file !== "string" || file === "") return;
  fs.appendFileSync(file, `${markdown}\n`);
}

// Emits a warning annotation and mirrors it into the step summary, so a job
// that ran with reduced protection says so on its summary page as well as in
// the annotations list. Callers pass the environment they were given so tests
// and entrypoints alike control where the summary goes.
function warning(message, title, env = {}) {
  const properties =
    title === undefined
      ? ""
      : ` title=${escapeAnnotation(title).replaceAll(":", "%3A").replaceAll(",", "%2C")}`;
  console.log(`::warning${properties}::${escapeAnnotation(message)}`);
  stepSummary(
    env,
    `> ⚠️ **${title ?? "Harden Runner"}:** ${message.replace(/\s*\r?\n\s*/g, " ")}`,
  );
}

module.exports = { escapeAnnotation, stepSummary, warning };
