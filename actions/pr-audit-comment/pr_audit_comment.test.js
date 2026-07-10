const assert = require("node:assert/strict");
const test = require("node:test");

const { checkPermission } = require("./pr_audit_comment");

function fixture({
  commenterAssociation = "MEMBER",
  commenterId = 1,
  commenterLogin = "member",
  prAuthorAssociation = "CONTRIBUTOR",
  prAuthorId = 1,
  prAuthorLogin = "member",
} = {}) {
  const failures = [];
  const pr = {
    author_association: prAuthorAssociation,
    head: { sha: "abc123" },
    user: { id: prAuthorId, login: prAuthorLogin },
  };

  return {
    core: { setFailed: (message) => failures.push(message) },
    failures,
    github: {
      rest: {
        pulls: {
          get: async () => ({ data: pr }),
        },
      },
    },
    context: {
      issue: { number: 609 },
      payload: {
        comment: {
          author_association: commenterAssociation,
          user: { id: commenterId, login: commenterLogin },
        },
      },
      repo: { owner: "tempoxyz", repo: "zones" },
    },
    pr,
  };
}

test.beforeEach(() => {
  process.env.PERMISSION_CHECK_MODE = "association";
});

test("allows a trusted PR author when the token reports CONTRIBUTOR", async () => {
  const input = fixture();

  const result = await checkPermission(input);

  assert.equal(result, input.pr);
  assert.deepEqual(input.failures, []);
});

test("rejects an untrusted commenter even when they authored the PR", async () => {
  const input = fixture({ commenterAssociation: "CONTRIBUTOR" });

  const result = await checkPermission(input);

  assert.equal(result, null);
  assert.deepEqual(input.failures, [
    "@member is not allowed to trigger Cyclops audits (CONTRIBUTOR)",
  ]);
});

test("still rejects an untrusted PR author when a different member comments", async () => {
  const input = fixture({ commenterId: 2, commenterLogin: "maintainer" });

  const result = await checkPermission(input);

  assert.equal(result, null);
  assert.deepEqual(input.failures, [
    "PR author @member is not allowed to trigger Cyclops audits (CONTRIBUTOR)",
  ]);
});

test("does not treat matching logins with different user IDs as the same author", async () => {
  const input = fixture({ commenterId: 2 });

  const result = await checkPermission(input);

  assert.equal(result, null);
  assert.equal(input.failures.length, 1);
});

test("does not bypass the fetched author association when user IDs are missing", async () => {
  const input = fixture({ commenterId: null, prAuthorId: null });

  const result = await checkPermission(input);

  assert.equal(result, null);
  assert.equal(input.failures.length, 1);
});

test("allows the fetched author association when user IDs are missing", async () => {
  const input = fixture({
    commenterId: null,
    prAuthorAssociation: "MEMBER",
    prAuthorId: null,
  });

  const result = await checkPermission(input);

  assert.equal(result, input.pr);
  assert.deepEqual(input.failures, []);
});
