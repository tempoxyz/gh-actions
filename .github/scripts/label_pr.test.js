const assert = require("node:assert/strict");
const test = require("node:test");

const labelPr = require("./label_pr.js");

const context = {
  repo: { owner: "tempoxyz", repo: "gh-actions" },
  payload: {
    pull_request: {
      number: 42,
      body: "Fixes #123",
    },
    repository: {
      html_url: "https://github.com/tempoxyz/gh-actions",
    },
  },
};

test("propagates errors when the referenced issue cannot be loaded", async () => {
  const expected = new Error("issue lookup failed");
  const github = {
    rest: {
      issues: {
        get: async () => {
          throw expected;
        },
      },
    },
  };

  await assert.rejects(labelPr({ github, context }), expected);
});

test("propagates errors when PR labels cannot be updated", async () => {
  const expected = new Error("label update failed");
  const github = {
    rest: {
      issues: {
        get: async () => ({ data: { labels: [{ name: "bug" }] } }),
        addLabels: async () => {
          throw expected;
        },
      },
    },
  };

  await assert.rejects(labelPr({ github, context }), expected);
});

test("keeps the no-issue-reference path as a no-op", async () => {
  const github = {
    rest: {
      issues: {
        get: async () => {
          throw new Error("should not be called");
        },
      },
    },
  };

  await labelPr({
    github,
    context: {
      ...context,
      payload: {
        ...context.payload,
        pull_request: { ...context.payload.pull_request, body: "No linked issue" },
      },
    },
  });
});
