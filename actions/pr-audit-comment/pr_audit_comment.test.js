const test = require("node:test");
const assert = require("node:assert/strict");

const handle = require("./pr_audit_comment.js");

function makePr({
  authorAssociation = "MEMBER",
  authorId = 2,
  authorLogin = "pr-author",
  headRepo = "tempoxyz/example",
} = {}) {
  return {
    author_association: authorAssociation,
    user: { id: authorId, login: authorLogin },
    head: {
      sha: "0123456789abcdef",
      repo: headRepo === null ? null : { full_name: headRepo },
    },
  };
}

function makeContext({
  commenterAssociation = "MEMBER",
  commenterId = 1,
  commenterLogin = "commenter",
} = {}) {
  return {
    repo: {
      owner: "tempoxyz",
      repo: "example",
    },
    issue: {
      number: 123,
    },
    payload: {
      comment: {
        id: 456,
        // Deliberately invalid argument: an allowed request reaches
        // createComment(), but never reaches publishEvent()/curl.
        body: "cyclops audit unsupported=value",
        author_association: commenterAssociation,
        user: { id: commenterId, login: commenterLogin },
      },
      issue: {
        pull_request: {},
      },
    },
  };
}

function makeCore() {
  const failures = [];

  return {
    failures,
    setFailed(message) {
      failures.push(String(message));
    },
    warning() {},
    debug() {},
  };
}

function makeClient({
  pr,
  checkMembership = async () => ({ status: 204 }),
}) {
  const calls = {
    pulls: [],
    membership: [],
    comments: [],
  };

  const client = {
    rest: {
      pulls: {
        async get(request) {
          calls.pulls.push(request);
          return { data: pr };
        },
      },
      orgs: {
        async checkMembershipForUser(request) {
          calls.membership.push(request);
          return checkMembership(request);
        },
      },
      issues: {
        async createComment(request) {
          calls.comments.push(request);
          return { data: { id: 789 } };
        },
      },
    },
  };

  return { client, calls };
}

function membershipStatuses(...statuses) {
  let index = 0;

  return async () => {
    const result = statuses[index++];

    if (result instanceof Error) {
      throw result;
    }

    return { status: result };
  };
}

function setEnvironment(values) {
  const previous = new Map();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function runScenario({
  mode,
  pr = makePr(),
  commenterAssociation = "MEMBER",
  commenterId = 1,
  commenterLogin = "commenter",
  permissionToken,
  allowSameRepositoryAuthor = false,
  primaryMembership = async () => ({ status: 204 }),
  permissionMembership = async () => ({ status: 204 }),
}) {
  const restoreEnvironment = setEnvironment({
    COMMAND_REGEX: "^cyclops\\s+audit\\b",
    PERMISSION_CHECK_MODE: mode,
    PERMISSION_TOKEN: permissionToken,
    ORGANIZATION: "tempoxyz",
    ALLOW_SAME_REPOSITORY_AUTHOR:
      allowSameRepositoryAuthor ? "true" : "false",
  });

  const primary = makeClient({
    pr,
    checkMembership: primaryMembership,
  });

  const permission = makeClient({
    pr,
    checkMembership: permissionMembership,
  });

  const getOctokitTokens = [];
  const getOctokit = (token) => {
    getOctokitTokens.push(token);
    return permission.client;
  };

  const core = makeCore();

  try {
    await handle({
      github: primary.client,
      context: makeContext({
        commenterAssociation,
        commenterId,
        commenterLogin,
      }),
      core,
      getOctokit,
    });
  } finally {
    restoreEnvironment();
  }

  return {
    core,
    primary,
    permission,
    getOctokitTokens,
  };
}

test("org mode uses a separate client for permission-token", async () => {
  const result = await runScenario({
    mode: "org",
    permissionToken: "membership-token",
    primaryMembership: async () => {
      throw new Error("primary GitHub client must not check membership");
    },
    permissionMembership: membershipStatuses(204, 204),
  });

  assert.deepEqual(result.getOctokitTokens, ["membership-token"]);
  assert.equal(result.primary.calls.membership.length, 0);
  assert.equal(result.permission.calls.membership.length, 2);

  // The token belongs to the secondary client and should not be copied
  // into per-request options.
  assert.equal(
    Object.hasOwn(result.permission.calls.membership[0], "headers"),
    false,
  );

  // PR reads and status comments continue to use the primary client.
  assert.equal(result.primary.calls.pulls.length, 1);
  assert.equal(result.primary.calls.comments.length, 1);
});

test("org mode falls back to github-token when permission-token is omitted", async () => {
  const result = await runScenario({
    mode: "org",
    permissionToken: undefined,
    primaryMembership: membershipStatuses(204, 204),
  });

  assert.deepEqual(result.getOctokitTokens, []);
  assert.equal(result.primary.calls.membership.length, 2);
  assert.equal(result.permission.calls.membership.length, 0);
  assert.equal(result.primary.calls.comments.length, 1);
});

test("org mode does not accept HTTP 302 as membership", async () => {
  const result = await runScenario({
    mode: "org",
    permissionToken: "membership-token",
    permissionMembership: membershipStatuses(302),
  });

  assert.equal(result.permission.calls.membership.length, 1);
  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /is not a member/);
});

test("org mode fails closed when permission-token cannot authenticate", async () => {
  const result = await runScenario({
    mode: "org",
    permissionToken: "invalid-membership-token",
    permissionMembership: async () => {
      throw Object.assign(new Error("Bad credentials"), { status: 401 });
    },
  });

  assert.deepEqual(result.getOctokitTokens, [
    "invalid-membership-token",
  ]);
  assert.equal(result.primary.calls.membership.length, 0);
  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /is not a member/);
});

test("org mode rejects a non-member PR author", async () => {
  const notFound = Object.assign(new Error("Not Found"), {
    status: 404,
  });

  const result = await runScenario({
    mode: "org",
    permissionToken: "membership-token",
    // Commenter is a member; PR author is not.
    permissionMembership: membershipStatuses(204, notFound),
  });

  assert.equal(result.permission.calls.membership.length, 2);
  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /PR author @pr-author is not a member/,
  );
});

test("trusted commenter who authored the PR bypasses a low fetched association", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: 7,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: 7,
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 1);
  assert.match(result.core.failures[0], /Invalid cyclops audit command/);
});

test("untrusted commenter is denied even when they authored the PR", async () => {
  const result = await runScenario({
    mode: "association",
    commenterAssociation: "CONTRIBUTOR",
    commenterId: 7,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: 7,
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /@commenter is not allowed/);
});

test("different trusted commenter cannot bypass a low author association", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: 8,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: 7,
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /PR author @pr-author is not allowed/);
});

test("matching login with different user IDs does not identify the PR author", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: 8,
    commenterLogin: "same-user",
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: 7,
      authorLogin: "same-user",
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /PR author @same-user is not allowed/);
});

test("missing user IDs fall back to the fetched author association", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: null,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: null,
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /PR author @pr-author is not allowed/);
});

test("trusted fetched author association remains allowed when user IDs are missing", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: null,
    pr: makePr({
      authorAssociation: "MEMBER",
      authorId: null,
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 1);
  assert.match(result.core.failures[0], /Invalid cyclops audit command/);
});

test("same-repository exception is disabled by default", async () => {
  const result = await runScenario({
    mode: "association",
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "tempoxyz/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /PR author @pr-author is not allowed/,
  );
});

test("same-repository exception can be enabled explicitly", async () => {
  const result = await runScenario({
    mode: "association",
    allowSameRepositoryAuthor: true,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "tempoxyz/example",
    }),
  });

  // Permission succeeded, so processing reached the invalid-command comment.
  assert.equal(result.primary.calls.comments.length, 1);
});

test("same-repository exception never permits a fork author", async () => {
  const result = await runScenario({
    mode: "association",
    allowSameRepositoryAuthor: true,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /PR author @pr-author is not allowed/,
  );
});

test("same-repository exception fails closed for a deleted fork", async () => {
  const result = await runScenario({
    mode: "association",
    allowSameRepositoryAuthor: true,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: null,
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /PR author @pr-author is not allowed/,
  );
});

test("untrusted commenter is rejected before the author exception", async () => {
  const result = await runScenario({
    mode: "association",
    commenterAssociation: "CONTRIBUTOR",
    allowSameRepositoryAuthor: true,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "tempoxyz/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /@commenter is not allowed/,
  );
});
