const { performance } = require("node:perf_hooks");
const started = performance.now();
const events = [];
const now = () => (performance.now() - started) / 1000;
function record(name, start, extra = {}) {
  events.push({ name, start, end: now(), ...extra });
}
async function timed(name, operation) {
  const start = now();
  try { return await operation(); } finally { record(name, start); }
}
module.exports = { events, now, record, timed };
