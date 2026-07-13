const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_MARKER_PREFIX = "<!-- stale-pr-warning:";
const DEFAULT_WARNING_MESSAGE = "This pull request has been inactive.";
const DEFAULT_CLOSE_MESSAGE = "Closing this pull request because it has been inactive for the configured interval.";
const WARNING_LABEL_COLOR = "fbca04";
const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]";
const VALID_ASSOCIATIONS = new Set([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
]);

function parseLines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, name) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  return Number(normalized);
}

function parseNonNegativeInteger(value, name) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative whole number.`);
  }
  return Number(normalized);
}

function parseBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseConfig(inputs) {
  const staleAfterDays = parsePositiveInteger(inputs.STALE_AFTER_DAYS, "stale-after-days");
  const warningDays = parseNonNegativeInteger(inputs.WARNING_DAYS, "warning-days");
  if (warningDays >= staleAfterDays && warningDays !== 0) {
    throw new Error("warning-days must be less than stale-after-days, or 0 to disable warnings.");
  }

  const authorAssociations = parseLines(inputs.AUTHOR_ASSOCIATIONS).map((value) => value.toUpperCase());
  const unknownAssociation = authorAssociations.find((value) => !VALID_ASSOCIATIONS.has(value));
  if (unknownAssociation) {
    throw new Error(`author-associations contains unsupported value: ${unknownAssociation}.`);
  }

  const requiredLabels = parseLines(inputs.REQUIRED_LABELS);
  const excludedLabels = parseLines(inputs.EXCLUDED_LABELS);
  const warningLabel = String(inputs.WARNING_LABEL ?? "").trim();
  if (!warningLabel) {
    throw new Error("warning-label must not be empty.");
  }

  const normalizedWarningLabel = warningLabel.toLowerCase();
  if ([...requiredLabels, ...excludedLabels].some((label) => label.toLowerCase() === normalizedWarningLabel)) {
    throw new Error("warning-label must not also be required or excluded.");
  }

  return {
    staleAfterDays,
    warningDays,
    authors: new Set(parseLines(inputs.AUTHORS).map((value) => value.toLowerCase())),
    authorAssociations: new Set(authorAssociations),
    requiredLabels: new Set(requiredLabels.map((value) => value.toLowerCase())),
    excludedLabels: new Set(excludedLabels.map((value) => value.toLowerCase())),
    warningLabel,
    warningMessage: String(inputs.WARNING_MESSAGE ?? DEFAULT_WARNING_MESSAGE),
    closeMessage: String(inputs.CLOSE_MESSAGE ?? DEFAULT_CLOSE_MESSAGE),
    dryRun: parseBoolean(inputs.DRY_RUN ?? "false", "dry-run"),
  };
}

function getLabelNames(pr) {
  return new Set((pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name).toLowerCase()));
}

function matchesSelectors(pr, config) {
  const author = pr.user?.login?.toLowerCase();
  if (config.authors.size > 0 && !config.authors.has(author)) return false;

  const association = String(pr.author_association ?? "NONE").toUpperCase();
  if (config.authorAssociations.size > 0 && !config.authorAssociations.has(association)) return false;

  const labels = getLabelNames(pr);
  if ([...config.requiredLabels].some((label) => !labels.has(label))) return false;
  if ([...config.excludedLabels].some((label) => labels.has(label))) return false;

  return true;
}

function staleDeadline(updatedAt, staleAfterDays) {
  return new Date(new Date(updatedAt).getTime() + staleAfterDays * DAY_MS);
}

function isAfter(date, reference) {
  return new Date(date).getTime() > new Date(reference).getTime();
}

function warningMarker(closeAt) {
  return `${WARNING_MARKER_PREFIX}${JSON.stringify({ closeAt: closeAt.toISOString() })} -->`;
}

function parseWarningMarker(comment) {
  const match = comment.body?.match(/<!-- stale-pr-warning:(\{.*?\}) -->/s);
  if (!match) return undefined;

  try {
    const marker = JSON.parse(match[1]);
    const closeAt = new Date(marker.closeAt);
    if (Number.isNaN(closeAt.getTime())) return undefined;
    return { comment, closeAt };
  } catch {
    return undefined;
  }
}

async function listComments(github, repo, issueNumber) {
  return github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

async function latestWarningMarker(github, repo, issueNumber) {
  const comments = await listComments(github, repo, issueNumber);
  return comments
    .filter((comment) => comment.user?.login === GITHUB_ACTIONS_BOT_LOGIN)
    .map(parseWarningMarker)
    .filter(Boolean)
    .sort((left, right) => new Date(right.comment.created_at) - new Date(left.comment.created_at))[0];
}

async function ensureWarningLabel(github, repo, name) {
  try {
    await github.rest.issues.getLabel({ ...repo, name });
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await github.rest.issues.createLabel({
        ...repo,
        name,
        color: WARNING_LABEL_COLOR,
        description: "Pull requests approaching automatic stale closure",
      });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
    }
  }
}

function warningComment(message, closeAt) {
  return `${message}\n\nThis pull request will be automatically closed on ${closeAt.toISOString()} unless new activity occurs.\n\n${warningMarker(closeAt)}`;
}

async function removeWarningLabel(github, repo, issueNumber, config) {
  try {
    await github.rest.issues.removeLabel({ ...repo, issue_number: issueNumber, name: config.warningLabel });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function closeStalePrs({ github, context, core, inputs, now = new Date() }) {
  const config = parseConfig(inputs);
  const repo = context.repo;
  const prs = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    sort: "updated",
    direction: "asc",
    per_page: 100,
  });

  let warningLabelEnsured = false;
  for (const pr of prs) {
    if (!matchesSelectors(pr, config)) continue;

    const labels = getLabelNames(pr);
    const hasWarningLabel = labels.has(config.warningLabel.toLowerCase());
    const deadline = staleDeadline(pr.updated_at, config.staleAfterDays);
    const shouldWarn = config.warningDays > 0 && config.warningMessage !== "" && now >= new Date(deadline.getTime() - config.warningDays * DAY_MS);

    if (hasWarningLabel) {
      const marker = await latestWarningMarker(github, repo, pr.number);
      if (marker && isAfter(pr.updated_at, marker.comment.created_at)) {
        core.info(`PR #${pr.number}: activity resumed after warning; removing ${config.warningLabel}.`);
        if (!config.dryRun) await removeWarningLabel(github, repo, pr.number, config);
        continue;
      }

      if (marker && now >= marker.closeAt) {
        core.info(`PR #${pr.number}: closing after warning deadline.`);
        if (!config.dryRun) {
          if (config.closeMessage !== "") {
            await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body: config.closeMessage });
          }
          await github.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
        }
        continue;
      }

      if (marker) continue;
    }

    if (now >= deadline) {
      core.info(`PR #${pr.number}: closing after ${config.staleAfterDays} stale days.`);
      if (!config.dryRun) {
        if (config.closeMessage !== "") {
          await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body: config.closeMessage });
        }
        await github.rest.pulls.update({ ...repo, pull_number: pr.number, state: "closed" });
      }
      continue;
    }

    if (shouldWarn) {
      core.info(`PR #${pr.number}: warning before automatic closure at ${deadline.toISOString()}.`);
      if (!config.dryRun) {
        if (!warningLabelEnsured) {
          await ensureWarningLabel(github, repo, config.warningLabel);
          warningLabelEnsured = true;
        }
        await github.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: [config.warningLabel] });
        await github.rest.issues.createComment({
          ...repo,
          issue_number: pr.number,
          body: warningComment(config.warningMessage, deadline),
        });
      }
    }
  }
}

module.exports = {
  DAY_MS,
  DEFAULT_CLOSE_MESSAGE,
  DEFAULT_WARNING_MESSAGE,
  closeStalePrs,
  matchesSelectors,
  parseConfig,
  parseWarningMarker,
  staleDeadline,
  warningComment,
};
