const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const usage = [
  '**Usage:** `cyclops audit [fast] [iterations=N] [hours=N] [config=pr-review.yaml] ',
  '[models="anthropic/claude-opus-4-7,openai/gpt-5.5"] [run-label=LABEL] ',
  '[dry-run] [note="per-run audit guidance"]`',
].join("");

function parseArgs(body, commandRegex) {
  const prefix = new RegExp(commandRegex, "i");
  const args = body.replace(prefix, "").trim();
  const parts = [];
  const argRegex = /(\S+?[=:]"[^"]*"|\S+?[=:]'[^']*'|\S+?[=:]\S+|\S+)/g;
  let match;
  while ((match = argRegex.exec(args)) !== null) parts.push(match[1]);

  const defaults = {
    config: "",
    iterations: "",
    hours: "",
    models: "",
    "run-label": "",
    "dry-run": "false",
    note: "",
  };
  const intArgs = new Set(["iterations", "hours"]);
  const stringArgs = new Set(["config", "models", "run-label", "note"]);
  const boolArgs = new Set(["dry-run"]);
  const unknown = [];
  const invalid = [];

  for (const part of parts) {
    if (part === "fast") {
      defaults.iterations = "1";
      continue;
    }

    const eq = part.indexOf("=");
    const colon = part.indexOf(":");
    const sep = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (sep === -1) {
      if (boolArgs.has(part)) {
        defaults[part] = "true";
      } else {
        unknown.push(part);
      }
      continue;
    }

    const key = part.slice(0, sep);
    let value = part.slice(sep + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (intArgs.has(key)) {
      if (!/^[1-9]\d*$/.test(value)) {
        invalid.push(`\`${key}=${value}\` (must be a positive integer)`);
      } else {
        defaults[key] = value;
      }
    } else if (boolArgs.has(key)) {
      if (value === "true" || value === "false") {
        defaults[key] = value;
      } else {
        invalid.push(`\`${key}=${value}\` (must be true or false)`);
      }
    } else if (stringArgs.has(key)) {
      if (!value) {
        invalid.push(`\`${key}=\` (must not be empty)`);
      } else {
        defaults[key] = value;
      }
    } else {
      unknown.push(key);
    }
  }

  const errors = [];
  if (unknown.length) errors.push(`Unknown argument(s): \`${unknown.join("`, `")}\``);
  if (invalid.length) errors.push(`Invalid value(s): ${invalid.join(", ")}`);
  return { defaults, errors };
}

async function checkPermission({ github, context, core }) {
  const mode = process.env.PERMISSION_CHECK_MODE;
  const commenterUser = context.payload.comment.user;
  const commenter = commenterUser.login;

  const { data: pr } = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
  });

  if (mode === "association") {
    const allowed = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
    const commenterAssociation = context.payload.comment.author_association;
    if (!allowed.has(commenterAssociation)) {
      core.setFailed(`@${commenter} is not allowed to trigger Cyclops audits (${commenterAssociation})`);
      return null;
    }

    // The issue_comment payload can identify a private org member even when the
    // repo-scoped token reports that same user as CONTRIBUTOR on pulls.get.
    // A trusted commenter who authored the PR has already satisfied both checks.
    const commenterIsPrAuthor = commenterUser.id != null && commenterUser.id === pr.user?.id;
    if (!commenterIsPrAuthor && !allowed.has(pr.author_association)) {
      core.setFailed(`PR author @${pr.user.login} is not allowed to trigger Cyclops audits (${pr.author_association})`);
      return null;
    }
    return pr;
  }

  if (mode !== "org") {
    core.setFailed(`Unsupported permission-check-mode: ${mode}`);
    return null;
  }

  const org = process.env.ORGANIZATION;
  const checkMembership = async (username) => {
    try {
      const { status } = await github.rest.orgs.checkMembershipForUser({ org, username });
      return status === 204 || status === 302;
    } catch {
      return false;
    }
  };

  if (!await checkMembership(commenter)) {
    core.setFailed(`@${commenter} is not a member of ${org}`);
    return null;
  }
  if (!await checkMembership(pr.user.login)) {
    core.setFailed(`PR author @${pr.user.login} is not a member of ${org}`);
    return null;
  }
  return pr;
}

function buildPayload(context, pr, defaults) {
  const data = {
    pr_number: context.issue.number,
    sha: pr.head.sha,
    source: "comment",
    actor: context.payload.comment.user.login,
    comment_id: context.payload.comment.id,
    dry_run: defaults["dry-run"] === "true",
  };
  if (defaults.config) data.config = defaults.config;
  if (defaults.iterations) data.max_iterations = Number(defaults.iterations);
  if (defaults.hours) data.max_hours = Number(defaults.hours);
  if (defaults.models) data.models = defaults.models;
  if (defaults["run-label"]) data.run_label = defaults["run-label"];
  if (defaults.note) data.audit_note_b64 = Buffer.from(defaults.note, "utf8").toString("base64");

  return {
    repository: `${context.repo.owner}/${context.repo.repo}`,
    event: "pr_audit",
    data,
  };
}

function buildSummary(defaults) {
  const summaryParts = [
    defaults.config ? `config: \`${defaults.config}\`` : "config: `default`",
    defaults.iterations ? `iterations: \`${defaults.iterations}\`` : "iterations: `default`",
    defaults.hours ? `hours: \`${defaults.hours}\`` : "hours: `default`",
  ];
  if (defaults.models) summaryParts.push(`models: \`${defaults.models}\``);
  if (defaults["run-label"]) summaryParts.push(`run-label: \`${defaults["run-label"]}\``);
  if (defaults["dry-run"] === "true") summaryParts.push("dry-run: `true`");
  if (defaults.note) {
    const note = defaults.note.replace(/`/g, "'").slice(0, 160);
    summaryParts.push(`note: \`${note}${defaults.note.length > 160 ? "..." : ""}\``);
  }
  return `**Config:** ${summaryParts.join(", ")}`;
}

function publishEvent(payload) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-"));
  const keyPath = path.join(tmp, "key");
  const certPath = path.join(tmp, "cert");
  const payloadPath = path.join(tmp, "payload.json");
  fs.writeFileSync(keyPath, process.env.EVENTS_KEY);
  fs.writeFileSync(certPath, process.env.EVENTS_CERT);
  fs.writeFileSync(payloadPath, JSON.stringify(payload));

  const script = [
    "set -euo pipefail",
    'curl -sf -o /dev/null -X POST $EVENTS_ARGS',
    '  -H "Content-Type: application/json"',
    '  --key "$KEY_PATH"',
    '  --cert "$CERT_PATH"',
    '  -d @"$PAYLOAD_PATH"',
  ].join(" \\\n");

  const result = spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      KEY_PATH: keyPath,
      CERT_PATH: certPath,
      PAYLOAD_PATH: payloadPath,
    },
    encoding: "utf8",
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`Failed to publish pr_audit event: ${result.stderr || result.stdout}`);
  }
}

async function handle({ github, context, core }) {
  // Only handle comments posted on pull requests; no-op on other events
  // so a misconfigured caller job exits cleanly instead of crashing.
  if (!context.payload.comment || !context.payload.issue?.pull_request) return;

  const body = context.payload.comment.body.trim();
  const commandRegex = process.env.COMMAND_REGEX;
  if (!new RegExp(commandRegex, "i").test(body)) return;

  const pr = await checkPermission({ github, context, core });
  if (!pr) return;

  const { defaults, errors } = parseArgs(body, commandRegex);
  if (errors.length) {
    const msg = `Invalid cyclops audit command\n\n${errors.join("\n")}\n\n${usage}`;
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body: msg,
    });
    core.setFailed(msg);
    return;
  }

  const summary = buildSummary(defaults);
  const actor = context.payload.comment.user.login;
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  let commentId;
  try {
    await github.rest.reactions.createForIssueComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: context.payload.comment.id,
      content: "eyes",
    });
  } catch (error) {
    core.warning(`Could not add acknowledgement reaction: ${error.message}`);
  }

  const { data: comment } = await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body: `cc @${actor}\n\nCyclops audit event queued. [View workflow run](${runUrl})\n\n${summary}`,
  });
  commentId = comment.id;

  try {
    publishEvent(buildPayload(context, pr, defaults));
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: commentId,
      body: `cc @${actor}\n\nCyclops audit event published. [View workflow run](${runUrl})\n\n${summary}`,
    });
  } catch (error) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: commentId,
      body: `cc @${actor}\n\nCyclops audit event failed to publish. [View workflow run](${runUrl})\n\n${summary}`,
    });
    core.setFailed(error.message);
  }
}

handle.checkPermission = checkPermission;
module.exports = handle;
