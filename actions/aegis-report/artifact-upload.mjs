import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import artifact from "@actions/artifact";

const reportPaths = {
  linux: "/var/log/aegis/service.jsonl",
  darwin: "/Library/Application Support/Aegis/service.jsonl",
};

export function aegisReportPath(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    return win32.join(env.ProgramData || "C:\\ProgramData", "Aegis", "service.jsonl");
  }
  const report = reportPaths[platform];
  if (!report) throw new Error(`Aegis audit-log upload is unsupported on ${platform}`);
  return report;
}

export function artifactName(action, env = process.env) {
  const safe = (value) => value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128);
  return `aegis-service-log-${safe(env.GITHUB_JOB || "job")}-${safe(action || "aegis-report")}`;
}

export function copyAegisReport(source, destination, platform = process.platform) {
  mkdirSync(dirname(destination), { recursive: true });
  if (platform === "linux") {
    execFileSync("sudo", ["cp", "--", source, destination], { stdio: "inherit" });
    execFileSync("sudo", ["chown", `${process.getuid()}:${process.getgid()}`, destination], { stdio: "inherit" });
  } else {
    copyFileSync(source, destination);
  }
}

export async function uploadAegisReport({ action, env = process.env } = {}) {
  const source = aegisReportPath(process.platform, env);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Aegis audit log was not found at ${source}`);
  }
  const destination = join(env.RUNNER_TEMP || dirname(source), "aegis-service.jsonl");
  copyAegisReport(source, destination);
  const name = artifactName(action, env);
  const result = await artifact.uploadArtifact(name, [destination], dirname(destination), {
    retentionDays: 7,
  });
  console.log(`Uploaded Aegis audit log as artifact ${name} (ID ${result.id}).`);
  return result;
}
