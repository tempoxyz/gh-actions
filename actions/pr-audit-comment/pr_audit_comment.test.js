const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
  body = "cyclops audit unsupported=value",
} = {}) {
  return {
    serverUrl: "https://github.com",
    runId: 999,
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
        body,
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
    commentUpdates: [],
    reactions: [],
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
        async updateComment(request) {
          calls.commentUpdates.push(request);
          return { data: { id: request.comment_id } };
        },
      },
      reactions: {
        async createForIssueComment(request) {
          calls.reactions.push(request);
          return { data: { id: 790 } };
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
  body,
  permissionToken,
  primaryMembership = async () => ({ status: 204 }),
  permissionMembership = async () => ({ status: 204 }),
}) {
  const restoreEnvironment = setEnvironment({
    COMMAND_REGEX: "^cyclops\\s+audit\\b",
    PERMISSION_CHECK_MODE: mode,
    PERMISSION_TOKEN: permissionToken,
    ORGANIZATION: "tempoxyz",
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
        body,
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

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeProcessHarness(tmp) {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);

  const pythonPath = spawnSync("sh", ["-c", "command -v python3"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.ok(pythonPath, "python3 is required for publication tests");

  const files = {
    pythonArgs: path.join(tmp, "python-args"),
    pythonEnv: path.join(tmp, "python-env"),
    curlArgs: path.join(tmp, "curl-args"),
    curlEnv: path.join(tmp, "curl-env"),
    payload: path.join(tmp, "payload.json"),
  };

  writeExecutable(path.join(bin, "python3"), `#!/bin/sh
printf '%s\n' "$@" > ${shellQuote(files.pythonArgs)}
env > ${shellQuote(files.pythonEnv)}
exec ${shellQuote(pythonPath)} "$@"
`);
  writeExecutable(path.join(bin, "curl"), `#!/bin/sh
printf '%s\n' "$@" > ${shellQuote(files.curlArgs)}
env > ${shellQuote(files.curlEnv)}
for arg in "$@"; do
  case "$arg" in
    @*) cp "\${arg#@}" ${shellQuote(files.payload)} ;;
  esac
done
cat >/dev/null
`);
  writeExecutable(path.join(bin, "jq"), `#!/bin/sh
printf '%s\n' '{"repository":"tempoxyz/example","event":"pr_audit","data":{}}'
`);

  return { bin, files };
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").trimEnd().split("\n");
}

function assertIsolatedEnvironment(file, expectedProxy = undefined) {
  const environment = readLines(file);
  if (expectedProxy === undefined) {
    assert.equal(environment.some((entry) => entry.startsWith("HTTP_PROXY=")), false);
  } else {
    assert.ok(environment.includes(`HTTP_PROXY=${expectedProxy}`));
  }
  assert.ok(environment.some((entry) => entry.startsWith("PATH=")));
  for (const name of [
    "EVENTS_KEY",
    "EVENTS_CERT",
    "EVENTS_ARGS",
    "PERMISSION_TOKEN",
    "PYTHONPATH",
    "SECRET_CANARY",
  ]) {
    assert.equal(
      environment.some((entry) => entry.startsWith(`${name}=`)),
      false,
      `${name} leaked to child process`,
    );
  }
}

function workflowPublishScript() {
  const lines = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/pr-audit.yml"),
    "utf8",
  ).split("\n");
  const name = lines.findIndex((line) => line.trim() === "- name: Publish event");
  assert.notEqual(name, -1);
  const run = lines.findIndex((line, index) => index > name && line.trim() === "run: |");
  assert.notEqual(run, -1);

  const script = [];
  for (const line of lines.slice(run + 1)) {
    if (line && !line.startsWith("          ")) break;
    script.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  return script.join("\n");
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
  assert.deepEqual(result.permission.calls.membership[0], {
    org: "tempoxyz",
    username: "commenter",
    request: { redirect: "manual" },
  });
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

test("external-fork author cannot bypass a low association by also commenting", async () => {
  const result = await runScenario({
    mode: "association",
    commenterId: 7,
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      authorId: 7,
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(result.core.failures[0], /External-fork PR author @pr-author/);
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
  assert.match(result.core.failures[0], /Audit commenter @commenter is not allowed/);
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
  assert.match(result.core.failures[0], /External-fork PR author @pr-author/);
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
  assert.match(result.core.failures[0], /External-fork PR author @same-user/);
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
  assert.match(result.core.failures[0], /External-fork PR author @pr-author/);
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

test("same-repository PR authors are allowed", async () => {
  const result = await runScenario({
    mode: "association",
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
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "external/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /External-fork PR author @pr-author/,
  );
});

test("same-repository exception fails closed for a deleted fork", async () => {
  const result = await runScenario({
    mode: "association",
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: null,
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /External-fork PR author @pr-author/,
  );
});

test("untrusted commenter is rejected before the author exception", async () => {
  const result = await runScenario({
    mode: "association",
    commenterAssociation: "CONTRIBUTOR",
    pr: makePr({
      authorAssociation: "CONTRIBUTOR",
      headRepo: "tempoxyz/example",
    }),
  });

  assert.equal(result.primary.calls.comments.length, 0);
  assert.match(
    result.core.failures[0],
    /Audit commenter @commenter is not allowed/,
  );
});

test("comment publisher preserves quoted arguments and isolates parser and curl", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-comment-test-"));
  const harness = makeProcessHarness(tmp);
  const hostile = path.join(tmp, "hostile workspace");
  const importMarker = path.join(tmp, "import-shadow-ran");
  const shellMarker = path.join(tmp, "shell-syntax-ran");
  fs.mkdirSync(hostile);
  for (const module of ["json", "shlex"]) {
    fs.writeFileSync(
      path.join(hostile, `${module}.py`),
      `open(${JSON.stringify(importMarker)}, "w").write("leaked")\n`,
    );
  }

  const proxy = "http://proxy.example:8080";
  const restoreEnvironment = setEnvironment({
    PATH: `${harness.bin}:${process.env.PATH}`,
    EVENTS_ARGS: `--url "https://events.example/a path" -H 'X-Literal: $(touch ${shellMarker})'`,
    EVENTS_KEY: "event-key-canary",
    EVENTS_CERT: "event-cert-canary",
    PYTHONPATH: hostile,
    SECRET_CANARY: "must-not-leak",
    HTTP_PROXY: proxy,
  });
  const previousCwd = process.cwd();

  try {
    process.chdir(hostile);
    const result = await runScenario({
      mode: "association",
      body: "cyclops audit perf note='quoted guidance'",
      permissionToken: "permission-token-canary",
    });

    assert.deepEqual(result.core.failures, []);
    assert.equal(result.primary.calls.commentUpdates.length, 1);
    assert.match(result.primary.calls.commentUpdates[0].body, /event published/);
    assert.match(result.primary.calls.commentUpdates[0].body, /perf: `true`/);
    assert.equal(JSON.parse(fs.readFileSync(harness.files.payload)).data.perf, true);
    assert.deepEqual(readLines(harness.files.pythonArgs).slice(0, 2), ["-I", "-c"]);
    assert.deepEqual(readLines(harness.files.curlArgs).slice(5, 9), [
      "--url",
      "https://events.example/a path",
      "-H",
      `X-Literal: $(touch ${shellMarker})`,
    ]);
    assertIsolatedEnvironment(harness.files.pythonEnv);
    assertIsolatedEnvironment(harness.files.curlEnv, proxy);
    assert.equal(fs.existsSync(importMarker), false);
    assert.equal(fs.existsSync(shellMarker), false);
  } finally {
    process.chdir(previousCwd);
    restoreEnvironment();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("comment publisher rejects empty and malformed event arguments", async () => {
  for (const [eventsArgs, message] of [
    ["", /must contain at least one curl argument/],
    ["'unterminated", /Invalid EVENTS_ARGS/],
  ]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-comment-invalid-"));
    const harness = makeProcessHarness(tmp);
    const restoreEnvironment = setEnvironment({
      PATH: `${harness.bin}:${process.env.PATH}`,
      EVENTS_ARGS: eventsArgs,
      EVENTS_KEY: "event-key-canary",
      EVENTS_CERT: "event-cert-canary",
    });

    try {
      const result = await runScenario({
        mode: "association",
        body: "cyclops audit",
      });
      assert.match(result.core.failures[0], message);
      assert.equal(result.primary.calls.commentUpdates.length, 1);
      assert.match(result.primary.calls.commentUpdates[0].body, /failed to publish/);
      assert.equal(fs.existsSync(harness.files.curlArgs), false);
    } finally {
      restoreEnvironment();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("reusable workflow publisher preserves arguments and isolates child processes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-workflow-test-"));
  const harness = makeProcessHarness(tmp);
  const hostile = path.join(tmp, "hostile workspace");
  const runnerTemp = path.join(tmp, "runner temp");
  const importMarker = path.join(tmp, "workflow-import-shadow-ran");
  const shellMarker = path.join(tmp, "workflow-shell-syntax-ran");
  fs.mkdirSync(hostile);
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(
    path.join(hostile, "shlex.py"),
    `open(${JSON.stringify(importMarker)}, "w").write("leaked")\n`,
  );

  const proxy = "http://proxy.example:8080";
  const result = spawnSync("bash", ["-c", workflowPublishScript()], {
    cwd: hostile,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${harness.bin}:${process.env.PATH}`,
      EVENTS_ARGS: `--url "https://events.example/a path" -H 'X-Literal: $(touch ${shellMarker})'`,
      EVENTS_KEY: "event-key-canary",
      EVENTS_CERT: "event-cert-canary",
      REPO: "tempoxyz/example",
      TARGET_PR_NUMBER: "123",
      TARGET_SHA: "0123456789abcdef",
      RUNNER_TEMP: runnerTemp,
      PYTHONPATH: hostile,
      SECRET_CANARY: "must-not-leak",
      HTTP_PROXY: proxy,
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readLines(harness.files.pythonArgs).slice(0, 3), ["-I", "-S", "-c"]);
    assert.deepEqual(readLines(harness.files.curlArgs).slice(5, 9), [
      "--url",
      "https://events.example/a path",
      "-H",
      `X-Literal: $(touch ${shellMarker})`,
    ]);
    assertIsolatedEnvironment(harness.files.pythonEnv);
    assertIsolatedEnvironment(harness.files.curlEnv, proxy);
    assert.equal(fs.existsSync(importMarker), false);
    assert.equal(fs.existsSync(shellMarker), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("reusable workflow publisher rejects empty and malformed event arguments", () => {
  for (const eventsArgs of ["", "'unterminated"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-audit-workflow-invalid-"));
    const harness = makeProcessHarness(tmp);
    const runnerTemp = path.join(tmp, "runner-temp");
    fs.mkdirSync(runnerTemp);
    const result = spawnSync("bash", ["-c", workflowPublishScript()], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${harness.bin}:${process.env.PATH}`,
        EVENTS_ARGS: eventsArgs,
        EVENTS_KEY: "event-key-canary",
        EVENTS_CERT: "event-cert-canary",
        REPO: "tempoxyz/example",
        TARGET_PR_NUMBER: "123",
        TARGET_SHA: "0123456789abcdef",
        RUNNER_TEMP: runnerTemp,
      },
    });

    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /must contain at least one curl argument/);
      assert.equal(fs.existsSync(harness.files.curlArgs), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});
