const assert = require("node:assert/strict");
const test = require("node:test");

const {
  closeStalePrs,
  matchesSelectors,
  parseConfig,
  warningComment,
} = require("./close_stale_prs");

const NOW = new Date("2026-07-13T12:00:00.000Z");
const REPO = { owner: "tempoxyz", repo: "example" };

function inputs(overrides = {}) {
  return {
    STALE_AFTER_DAYS: "30",
    WARNING_DAYS: "7",
    AUTHORS: "",
    AUTHOR_ASSOCIATIONS: "",
    REQUIRED_LABELS: "",
    EXCLUDED_LABELS: "",
    WARNING_LABEL: "stale-pr-warning",
    WARNING_MESSAGE: "This pull request has been inactive.",
    CLOSE_MESSAGE: "Closing due to inactivity.",
    DRY_RUN: "false",
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 42,
    updated_at: "2026-06-18T12:00:00.000Z",
    user: { login: "octavia" },
    author_association: "MEMBER",
    labels: [],
    ...overrides,
  };
}

function actionComment(overrides = {}) {
  return {
    user: { login: "github-actions[bot]" },
    ...overrides,
  };
}

function createGithub({ prs, comments = {}, missingWarningLabel = false }) {
  const calls = [];
  const paginationCalls = [];
  let warningLabelMissing = missingWarningLabel;
  const rest = {
    pulls: {
      list: async () => prs,
      update: async (args) => calls.push(["pulls.update", args]),
    },
    issues: {
      listComments: async () => [],
      getLabel: async (args) => {
        calls.push(["issues.getLabel", args]);
        if (warningLabelMissing) {
          warningLabelMissing = false;
          const error = new Error("Not Found");
          error.status = 404;
          throw error;
        }
      },
      createLabel: async (args) => calls.push(["issues.createLabel", args]),
      addLabels: async (args) => calls.push(["issues.addLabels", args]),
      removeLabel: async (args) => calls.push(["issues.removeLabel", args]),
      createComment: async (args) => calls.push(["issues.createComment", args]),
    },
  };

  return {
    calls,
    paginationCalls,
    github: {
      rest,
      paginate: async (method, args) => {
        paginationCalls.push([method, args]);
        if (method === rest.pulls.list) return prs;
        if (method === rest.issues.listComments) return comments[args.issue_number] ?? [];
        throw new Error("Unexpected paginated endpoint");
      },
    },
  };
}

function core() {
  return { info: () => {} };
}

test("parses selectors and rejects unsafe warning-label overlap", () => {
  const config = parseConfig(inputs({
    AUTHORS: "octavia\narthur",
    AUTHOR_ASSOCIATIONS: "member\nowner",
    REQUIRED_LABELS: "automation\nrelease",
    EXCLUDED_LABELS: "do-not-close",
  }));

  assert.equal(config.authors.has("octavia"), true);
  assert.equal(config.authorAssociations.has("MEMBER"), true);
  assert.equal(config.requiredLabels.has("release"), true);
  assert.throws(
    () => parseConfig(inputs({ REQUIRED_LABELS: "stale-pr-warning" })),
    /warning-label must not also be required or excluded/,
  );
  assert.throws(() => parseConfig(inputs({ WARNING_DAYS: "30" })), /warning-days must be less/);
});

test("requires every required label and excludes matching excluded labels", () => {
  const config = parseConfig(inputs({
    AUTHORS: "octavia",
    AUTHOR_ASSOCIATIONS: "MEMBER",
    REQUIRED_LABELS: "automation\nrelease",
    EXCLUDED_LABELS: "do-not-close",
  }));

  assert.equal(matchesSelectors(pullRequest({ labels: [{ name: "automation" }, { name: "release" }] }), config), true);
  assert.equal(matchesSelectors(pullRequest({ labels: [{ name: "automation" }] }), config), false);
  assert.equal(matchesSelectors(pullRequest({ labels: [{ name: "automation" }, { name: "release" }, { name: "do-not-close" }] }), config), false);
});

test("creates the warning label and one deadline-bearing warning comment", async () => {
  const { github, calls } = createGithub({
    prs: [pullRequest()],
    missingWarningLabel: true,
  });

  await closeStalePrs({ github, context: { repo: REPO }, core: core(), inputs: inputs(), now: NOW });

  assert.deepEqual(calls.map(([name]) => name), [
    "issues.getLabel",
    "issues.createLabel",
    "issues.addLabels",
    "issues.createComment",
  ]);
  const comment = calls.at(-1)[1].body;
  assert.match(comment, /2026-07-18T12:00:00.000Z/);
  assert.match(comment, /<!-- stale-pr-warning:/);
});

test("does not duplicate an active warning before its deadline", async () => {
  const markerDate = "2026-07-12T12:00:00.000Z";
  const { github, calls } = createGithub({
    prs: [pullRequest({
      updated_at: markerDate,
      labels: [{ name: "stale-pr-warning" }],
    })],
    comments: {
      42: [actionComment({ created_at: markerDate, body: warningComment("warning", new Date("2026-07-18T12:00:00.000Z")) })],
    },
  });

  await closeStalePrs({ github, context: { repo: REPO }, core: core(), inputs: inputs(), now: NOW });

  assert.deepEqual(calls, []);
});

test("removes the warning label when activity resumes after a warning", async () => {
  const { github, calls } = createGithub({
    prs: [pullRequest({
      updated_at: "2026-07-12T13:00:00.000Z",
      labels: [{ name: "stale-pr-warning" }],
    })],
    comments: {
      42: [actionComment({
        created_at: "2026-07-12T12:00:00.000Z",
        body: warningComment("warning", new Date("2026-07-18T12:00:00.000Z")),
      })],
    },
  });

  await closeStalePrs({ github, context: { repo: REPO }, core: core(), inputs: inputs(), now: NOW });

  assert.deepEqual(calls.map(([name]) => name), ["issues.removeLabel"]);
});

test("closes a warned PR after its stored deadline", async () => {
  const { github, calls } = createGithub({
    prs: [pullRequest({
      updated_at: "2026-07-12T12:00:00.000Z",
      labels: [{ name: "stale-pr-warning" }],
    })],
    comments: {
      42: [actionComment({
        created_at: "2026-07-12T12:00:00.000Z",
        body: warningComment("warning", new Date("2026-07-13T11:00:00.000Z")),
      })],
    },
  });

  await closeStalePrs({ github, context: { repo: REPO }, core: core(), inputs: inputs(), now: NOW });

  assert.deepEqual(calls.map(([name]) => name), ["issues.createComment", "pulls.update"]);
  assert.equal(calls[1][1].state, "closed");
});

test("ignores an untrusted warning marker and clears the warning after activity", async () => {
  const { github, calls } = createGithub({
    prs: [pullRequest({
      updated_at: "2026-07-12T12:01:00.000Z",
      labels: [{ name: "stale-pr-warning" }],
    })],
    comments: {
      42: [
        actionComment({
          created_at: "2026-07-12T12:00:00.000Z",
          body: warningComment("warning", new Date("2026-07-18T12:00:00.000Z")),
        }),
        {
          created_at: "2026-07-12T12:01:00.000Z",
          user: { login: "untrusted-user" },
          body: warningComment("forged warning", new Date("2026-07-13T11:00:00.000Z")),
        },
      ],
    },
  });

  await closeStalePrs({ github, context: { repo: REPO }, core: core(), inputs: inputs(), now: NOW });

  assert.deepEqual(calls.map(([name]) => name), ["issues.removeLabel"]);
});

test("closes silently when warnings and close comments are disabled", async () => {
  const { github, calls } = createGithub({
    prs: [pullRequest({ updated_at: "2026-06-01T12:00:00.000Z" })],
  });

  await closeStalePrs({
    github,
    context: { repo: REPO },
    core: core(),
    inputs: inputs({ WARNING_DAYS: "0", CLOSE_MESSAGE: "" }),
    now: NOW,
  });

  assert.deepEqual(calls.map(([name]) => name), ["pulls.update"]);
});

test("dry-run logs stale candidates without mutating them", async () => {
  const { github, calls, paginationCalls } = createGithub({
    prs: [pullRequest({ updated_at: "2026-06-01T12:00:00.000Z" })],
  });
  const messages = [];

  await closeStalePrs({
    github,
    context: { repo: REPO },
    core: { info: (message) => messages.push(message) },
    inputs: inputs({ DRY_RUN: "true" }),
    now: NOW,
  });

  assert.deepEqual(calls, []);
  assert.equal(paginationCalls[0][0], github.rest.pulls.list);
  assert.equal(paginationCalls[0][1].per_page, 100);
  assert.match(messages[0], /closing after 30 stale days/);
});
