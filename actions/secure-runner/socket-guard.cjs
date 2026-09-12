const { spawn, spawnSync } = require("node:child_process");
const { constants } = require("node:os");
const path = require("node:path");

// Temporary mitigation for https://github.com/SocketDev/sfw-free/issues/61.
// A report being written does not imply that Socket completed successfully.
const signature = Buffer.from("Socket Firewall encountered an unexpected error");

function detector() {
  let tail = Buffer.alloc(0);
  return (chunk) => {
    const bytes = Buffer.concat([tail, chunk]);
    const found = bytes.includes(signature);
    tail = bytes.subarray(Math.max(0, bytes.length - signature.length + 1));
    return found;
  };
}

function run([bash, binary, ...args]) {
  if (!bash || !binary || !args.length) throw new Error("Missing Socket guard command");
  // Bash performs the same executable/shebang handling as the old launcher,
  // including Git for Windows. No user argument is interpolated into shell code.
  const child = spawn(bash, ["--noprofile", "--norc", "-c", 'exec "$@"', "socket-guard", binary, ...args], {
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let internalError = false;
  let infrastructureError = false;
  let cancelled;
  let killTimer;
  let exited = false;

  function terminate(signal) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        // Node's Windows kill() only terminates one process, not its descendants.
        const result = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        if (result.error || result.status !== 0) child.kill();
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if (error.code !== "ESRCH") infrastructureError = true;
    }
  }

  function cancel(signal) {
    cancelled ||= signal;
    terminate(signal);
    // A child ignoring cancellation must not leave CI waiting indefinitely.
    killTimer ||= setTimeout(() => terminate("SIGKILL"), 1000);
    killTimer.unref();
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = signals.map((signal) => {
    const handler = () => cancel(signal);
    process.on(signal, handler);
    return handler;
  });

  for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    const detectsError = detector();
    source.on("data", (chunk) => { internalError = detectsError(chunk) || internalError; });
    // pipe preserves bytes, stream separation and backpressure. Never merge JSON
    // stdout with diagnostics, or buffer an entire build log in memory/on disk.
    source.pipe(destination, { end: false });
    source.on("error", () => { infrastructureError = true; cancel("SIGTERM"); });
    destination.on("error", () => { infrastructureError = true; if (!exited) cancel("SIGTERM"); process.exitCode = 1; });
  }
  child.on("error", () => {
    infrastructureError = true;
    console.error("::error::Socket guard could not start the wrapped command");
  });
  child.on("exit", () => { exited = true; });
  child.on("close", (code, signal) => {
    clearTimeout(killTimer);
    signals.forEach((name, index) => process.removeListener(name, handlers[index]));
    if (internalError) console.error("::error::Socket reported an internal failure; refusing a successful exit");
    process.exitCode = cancelled ? 128 + constants.signals[cancelled]
      : signal ? 128 + constants.signals[signal]
        : code ? code : internalError || infrastructureError ? 1 : 0;
  });
}

if (require.main === module) {
  try { run(process.argv.slice(2)); }
  catch { console.error("::error::Socket guard could not initialize"); process.exitCode = 1; }
}

module.exports = { detector };
