const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inflateSync } = require("node:zlib");
const { createHash } = require("node:crypto");

function linkedPurls(url) {
  const params = new URL(url).searchParams;
  return params.has("purls")
    ? JSON.parse(inflateSync(Buffer.from(params.get("purls"), "base64url")))
    : params.getAll("purl");
}

const manifest = fs.readFileSync(path.join(__dirname, "action.yml"), "utf8");

test("registers a post-job Aegis audit-log upload", () => {
  assert.match(manifest, /runs:\r?\n  using: "node24"\r?\n  main: "main\.cjs"\r?\n  post: "post\.cjs"/);
  const { aegisReportPath, artifactName } = require("./dist/artifact-upload.cjs");
  assert.equal(aegisReportPath("linux"), "/var/log/aegis/service.jsonl");
  assert.equal(aegisReportPath("darwin"), "/Library/Application Support/Aegis/service.jsonl");
  assert.equal(
    aegisReportPath("win32", { ProgramData: "C:\\ProgramData" }),
    "C:\\ProgramData\\Aegis\\service.jsonl",
  );
  assert.equal(
    artifactName("aegis-report", { GITHUB_JOB: "lint / check" }),
    "aegis-service-log-lint---check-aegis-report",
  );
  assert.match(fs.readFileSync(path.join(__dirname, "post.cjs"), "utf8"), /uploadAegisReport/);
});

test("post skips teardown only on explicitly GitHub-hosted runners", async () => {
  const { main: postMain } = require("./post.cjs");
  const failing = () => {
    throw new Error("aegis uninstall exited 1");
  };
  const run = (env) => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    return postMain({ upload: async () => {}, cleanup: failing, quiesce: async () => {}, env, platform: "linux" })
      .finally(() => {
        console.log = original;
      })
      .then(() => lines);
  };

  const hosted = await run({ STATE_installation_identity: "abc", RUNNER_ENVIRONMENT: "github-hosted" });
  assert.deepEqual(hosted, []);

  for (const environment of ["self-hosted", undefined, "", "unknown"]) {
    await assert.rejects(
      run({ STATE_installation_identity: "abc", ...(environment ? { RUNNER_ENVIRONMENT: environment } : {}) }),
      /aegis uninstall exited 1/,
      `cleanup must stay hard when RUNNER_ENVIRONMENT is ${environment}`,
    );
  }

  // Without an armed identity, or off Linux, cleanup does not run at all.
  let cleanups = 0;
  await postMain({
    upload: async () => {},
    cleanup: () => {
      cleanups += 1;
    },
    env: { RUNNER_ENVIRONMENT: "github-hosted" },
    platform: "linux",
  });
  await postMain({
    upload: async () => {},
    cleanup: () => {
      cleanups += 1;
    },
    env: { STATE_installation_identity: "abc" },
    platform: "darwin",
  });
  assert.equal(cleanups, 0);
});

test("post annotates runtime warning decisions without duplicating lookup diagnostics", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-report-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const copiedLog = path.join(temp, "aegis-service.jsonl");
  const summary = path.join(temp, "summary.md");
  const records = [
    { msg: "socket lookup complete", action: "warn", result: "warn" },
    { msg: "package decision", action: "allow", reason: "allowed" },
    { msg: "package decision", action: "warn", reason: "Not connected to internet" },
    { msg: "package decision", action: "warn", reason: "upstream\n::error::secret" },
    null,
  ];
  const { main: postMain } = require("./post.cjs");
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await postMain({
      upload: async () => fs.writeFileSync(copiedLog, records.map(JSON.stringify).join("\n") + "\nnot JSON\n"),
      env: { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary },
      platform: "linux",
    });
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, [
    "::warning title=Aegis runtime warning verdicts::Aegis allowed 2 package downloads with warning verdicts: Not connected to internet (1), other warning verdicts (1). Review the Aegis audit-log artifact for details.",
  ]);
  assert.match(fs.readFileSync(summary, "utf8"), /Not connected to internet/);
  assert.doesNotMatch(fs.readFileSync(summary, "utf8"), /secret/);
});

test("post still reports copied warning verdicts when artifact upload fails", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-upload-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await require("./post.cjs").main({
      upload: async () => {
        fs.writeFileSync(path.join(temp, "aegis-service.jsonl"), '{"msg":"package decision","action":"warn","reason":"Aegis server unreachable"}\n');
        throw new Error("artifact service unavailable");
      },
      env: { RUNNER_TEMP: temp },
      platform: "linux",
    });
  } finally {
    console.log = original;
  }
  assert.match(lines[0], /Aegis audit-log upload failed::artifact service unavailable/);
  assert.match(lines[1], /Aegis runtime warning verdicts::.*Aegis server unreachable \(1\)/);
});

test("post links warning and blocked download summaries to the current workflow attempt", async (t) => {
  const context = {
    GITHUB_REPOSITORY: "tempo-xyz/my_repo.test",
    GITHUB_RUN_ID: "36356904356",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const link = "[View all events for this workflow in Aegis](https://go/aegis/tempo-xyz/my_repo.test/workflows/36356904356/2)";
  const cases = [
    { name: "warn", actions: ["warn"], linked: true },
    { name: "block", actions: ["block"], linked: true, blocked: 1 },
    { name: "mixed", actions: ["warn", "block", "allow", "block"], linked: true, blocked: 2 },
    { name: "allow", actions: ["allow"], linked: false },
    { name: "lookup diagnostics", records: [{ msg: "socket lookup complete", action: "block" }], linked: false },
    { name: "missing repository", actions: ["warn"], env: { GITHUB_REPOSITORY: "" }, linked: false },
    { name: "missing run ID", actions: ["warn"], env: { GITHUB_RUN_ID: "" }, linked: false },
    { name: "missing attempt", actions: ["warn"], env: { GITHUB_RUN_ATTEMPT: "" }, linked: false },
    { name: "invalid repository", actions: ["block"], env: { GITHUB_REPOSITORY: "owner" }, linked: false, blocked: 1 },
    { name: "invalid run ID", actions: ["warn"], env: { GITHUB_RUN_ID: "123/4" }, linked: false },
    { name: "invalid attempt", actions: ["warn"], env: { GITHUB_RUN_ATTEMPT: "0" }, linked: false },
    { name: "upload failure", actions: ["warn", "block"], uploadFails: true, linked: true, blocked: 1 },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-summary-test-"));
      t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
      const summary = path.join(temp, "summary.md");
      const records = entry.records || entry.actions.map((action) => ({ msg: "package decision", action, reason: "upstream secret" }));
      const lines = [];
      const original = console.log;
      console.log = (line) => lines.push(String(line));
      try {
        await require("./post.cjs").report({
          upload: async () => {
            fs.writeFileSync(path.join(temp, "aegis-service.jsonl"), records.map(JSON.stringify).join("\n"));
            if (entry.uploadFails) throw new Error("artifact service unavailable");
          },
          env: { ...context, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary, ...entry.env },
          platform: "linux",
        });
      } finally {
        console.log = original;
      }
      const markdown = fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "";
      assert.equal(markdown.includes(link), entry.linked);
      assert.equal((markdown.match(/View all events for this workflow in Aegis/g) || []).length, entry.linked ? 1 : 0);
      if (entry.blocked) {
        assert.ok(markdown.includes(`Aegis blocked ${entry.blocked} package download${entry.blocked === 1 ? "" : "s"}.`));
        assert.ok(lines.every((line) => !line.includes("Aegis blocked")), "blocks do not emit a warning annotation");
      }
      if (entry.actions?.includes("warn")) assert.match(markdown, /Aegis runtime warning verdicts/);
      assert.doesNotMatch(markdown, /upstream secret/);
      if (!entry.linked) assert.doesNotMatch(markdown, /https:\/\/go\/aegis/);
    });
  }
});

test("post lists recently published blocks and links one exemption dialog for them", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-exemptions-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const summary = path.join(temp, "summary.md");
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const decision = (fields) => ({ msg: "package decision", action: "block", category: "policy", ...fields });
  const records = [
    decision({ purl: "pkg:npm/%40tempo/example@1.2.3", reason: "didYouMean, recentlyPublished" }),
    decision({ purl: "pkg:pypi/requests@2.32.0?artifact_id=wheel", reason: "Recently published", policy_alerts: [{ type: "recentlyPublished", action: "block" }] }),
    decision({ purl: "pkg:npm/%40tempo/example@1.2.3", reason: "recentlyPublished" }),
    decision({ purl: "pkg:npm/malware@1.0.0", reason: "malware" }),
    decision({ purl: "pkg:npm/warned@1.0.0", reason: "Recently published", policy_alerts: [{ type: "recentlyPublished", action: "warn" }] }),
    decision({ purl: "pkg:npm/unavailable@1.0.0", reason: "recentlyPublished", category: "lookup_error" }),
    decision({ purl: "pkg:npm/no-version", reason: "recentlyPublished" }),
    { msg: "package decision", action: "warn", category: "policy", purl: "pkg:npm/warning@1.0.0", reason: "recentlyPublished" },
  ];
  await require("./post.cjs").report({
    upload: async () => fs.writeFileSync(path.join(temp, "aegis-service.jsonl"), records.map(JSON.stringify).join("\n")),
    env: { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: summary },
    platform: "linux",
  });
  const markdown = fs.readFileSync(summary, "utf8");
  assert.match(markdown, /Aegis blocked 7 package downloads\./);
  assert.ok(markdown.includes([
    "> 🕒 **Aegis blocked 2 recently published package versions:**",
    ">",
    "> - `@tempo/example@1.2.3` (`npm`)",
    "> - `requests@2.32.0` (`pypi`)",
    ">",
  ].join("\n")));
  const links = [...markdown.matchAll(/\[Add Aegis exemptions for these packages\]\((https:\/\/go\/aegis\/policies\?[^)\s]+)\)/g)];
  assert.equal(links.length, 1);
  const url = new URL(links[0][1]);
  assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([key]) => key !== "purl" && key !== "purls")), {
    org: "*", repo: "*", reason: "recentlyPublished", verdict: "warn", confirm: "1",
  });
  assert.deepEqual(linkedPurls(url), ["pkg:npm/%40tempo/example@1.2.3", "pkg:pypi/requests@2.32.0?artifact_id=wheel"]);
  assert.doesNotMatch(markdown, /malware@|warned@|unavailable@|no-version|warning@/);
  const { escapeAnnotation } = require("../harden-runner/annotations.cjs");
  assert.equal(lines.filter((line) => line.startsWith("::error ")).length, 1);
  assert.equal(lines.find((line) => line.startsWith("::error ")), [
    "::error title=Aegis blocked recently published package versions::",
    escapeAnnotation([
      "Aegis blocked 2 recently published package versions:",
      `Add Aegis exemptions: ${url.href}`,
      "- @tempo/example@1.2.3 (npm)",
      "- requests@2.32.0 (pypi)",
      "Each exemption downgrades recentlyPublished to a warning for that exact version only.",
      "After approval, rerun failed jobs. See the step summary for all packages and exemption links.",
    ].join("\n")),
  ].join(""));
});

test("recently published annotations escape coordinates and batch exemption URLs", () => {
  const { recentlyPublishedAnnotation } = require("./runtime-warnings.cjs");
  assert.equal(recentlyPublishedAnnotation([]), "");
  const one = recentlyPublishedAnnotation(["pkg:npm/%40tempo/test%0A%3A%3Aerror%3A%3A@1.0.0"]);
  assert.equal(one.split("\n").find(line => line.startsWith("- ")), "- @tempo/test ::error::@1.0.0 (npm)");
  assert.match(one, /^Aegis blocked 1 recently published package version:/);

  const purls = Array.from({ length: 51 }, (_, i) => `pkg:npm/p${i}@1.0.0`);
  const many = recentlyPublishedAnnotation(purls);
  assert.equal(many.split("\n").filter((line) => line.startsWith("- ")).length, 5);
  assert.match(many, /See the step summary for all packages and exemption links\./);
  const links = [...many.matchAll(/^Add Aegis exemptions: (\S+)$/gm)];
  assert.deepEqual(links.flatMap((link) => linkedPurls(link[1])), purls);
  assert.equal(links.length, 2);
});

test("recently published summaries batch links for the policies page and render coordinates inertly", () => {
  const { recentlyPublishedSummary } = require("./runtime-warnings.cjs");
  assert.equal(recentlyPublishedSummary([]), "");
  const one = recentlyPublishedSummary(["pkg:npm/%60%5Bx%5D(https%3A%2F%2Fevil)%0A%23@1.0.0"]);
  assert.match(one, /blocked 1 recently published package version:/);
  assert.ok(one.includes("> - `` `[x](https://evil) #@1.0.0 `` (`npm`)"), one);
  assert.match(one, /\[Add Aegis exemptions for this package\]\(https:\/\/go\/aegis\/policies\?[^)\s]+\)\n/);

  const many = recentlyPublishedSummary(Array.from({ length: 51 }, (_, i) => `pkg:npm/p${i}@1.0.0`));
  assert.equal((many.match(/^> - `p\d+@1\.0\.0` \(`npm`\)$/gm) || []).length, 50);
  assert.match(many, /^> - …and 1 more in the Aegis audit-log artifact$/m);
  const links = [...many.matchAll(/\[Add Aegis exemptions for these packages \((\d+)–(\d+)\)\]\(([^)]+)\)/g)];
  assert.deepEqual(links.map((link) => [link[1], link[2]]), [["1", "50"], ["51", "51"]]);
  assert.deepEqual(linkedPurls(links[1][3]), ["pkg:npm/p50@1.0.0"]);
});

test("compressed exemption links round-trip coordinates and keep short legacy links", () => {
  const { exemptionUrl } = require("./runtime-warnings.cjs");
  const one = ["pkg:npm/x@1"];
  assert.equal(new URL(exemptionUrl(one)).searchParams.has("purl"), true);
  const purls = Array.from({ length: 50 }, (_, i) => `pkg:npm/%40scope/package-${i}@1.2.3+linux-x64?artifact=tarball`);
  const url = exemptionUrl(purls);
  assert.equal(new URL(url).searchParams.has("purls"), true);
  assert.deepEqual(linkedPurls(url), purls);
});

test("annotation size budgets preserve complete URLs and direct overflow to the summary", () => {
  const { recentlyPublishedAnnotation, recentlyPublishedSummary } = require("./runtime-warnings.cjs");
  const { escapeAnnotation } = require("../harden-runner/annotations.cjs");
  // Long distinct coordinates defeat the compression ratio of numbered fixtures.
  const purls = Array.from({ length: 50 }, (_, i) => "pkg:npm/" + Array.from({ length: 8 }, (_, j) =>
    createHash("sha256").update(`${i}-${j}`).digest("hex")).join("") + "@1.2.3");
  const summary = recentlyPublishedSummary(purls);
  const summaryLinks = [...summary.matchAll(/\]\((https:\/\/go\/aegis\/policies\?[^)]+)\)/g)].map(match => match[1]);
  assert.deepEqual(summaryLinks.flatMap(linkedPurls), purls);
  assert.ok(summaryLinks.length > 1);
  for (const url of summaryLinks) assert.ok(url.length <= 3500);
  const annotation = recentlyPublishedAnnotation(purls);
  const links = [...annotation.matchAll(/^Add Aegis exemptions: (\S+)$/gm)].map(match => match[1]);
  assert.ok(links.length > 0 && links.length < summaryLinks.length);
  for (const url of links) assert.ok(summaryLinks.includes(url));
  assert.ok(escapeAnnotation(annotation).length <= 4000);
  assert.ok(`::error title=Aegis blocked recently published package versions::${escapeAnnotation(annotation)}`.length < 4096);
  assert.match(annotation, /See the step summary for all packages and exemption links\./);
});

test("an oversized individual coordinate falls back without emitting a partial URL", () => {
  const { recentlyPublishedAnnotation, recentlyPublishedSummary } = require("./runtime-warnings.cjs");
  const purl = "pkg:npm/" + Array.from({length: 160}, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("") + "@1";
  assert.doesNotMatch(recentlyPublishedAnnotation([purl]), /Add Aegis exemptions:/);
  assert.match(recentlyPublishedSummary([purl]), /too large for an exemption link/);
});
