const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { append, required } = require("../step-security-sts/main.cjs");

function bundlePath(platform, env) {
  if (platform === "linux") return "/etc/aegis/bundle.pem";
  if (platform === "darwin") return "/Library/Application Support/Aegis/bundle.pem";
  if (platform === "win32") return path.win32.join(env.ProgramData || "C:\\ProgramData", "Aegis", "bundle.pem");
  throw new Error(`Unsupported platform: ${platform}`);
}

function exportNodeTrust({ env = process.env, platform = process.platform, bundle = bundlePath(platform, env) } = {}) {
  const environmentFile = required("GITHUB_ENV", env);
  const aegisCertificates = fs.readFileSync(bundle);
  let certificates = bundle;
  if (env.NODE_EXTRA_CA_CERTS && env.NODE_EXTRA_CA_CERTS !== bundle) {
    const existingCertificates = fs.readFileSync(env.NODE_EXTRA_CA_CERTS);
    const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "aegis-node-ca-"));
    certificates = path.join(directory, "bundle.pem");
    fs.writeFileSync(certificates, Buffer.concat([existingCertificates, Buffer.from("\n"), aegisCertificates]), { mode: 0o600, flag: "wx" });
  }
  append(environmentFile, "NODE_EXTRA_CA_CERTS", certificates);
  return certificates;
}

module.exports = { bundlePath, exportNodeTrust };
