const { exchange, request } = require("../github-sts/main.js");
const { revokeToken } = require("../github-sts/post.js");
const { isTransientStatus, retry, retryAfterMs } = require("../github-sts/retry.js");

const USER_AGENT = "tempoxyz-gh-actions-skill-sync";
const STS_BUDGET_MS = 90 * 1000;

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Mints repository-scoped read tokens through the STS, so a private source
// only needs a trust policy in its own repository. Returns null outside
// GitHub Actions or without `id-token: write`.
function stsMinter({ policy, host, env = process.env, send = request }) {
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!requestToken || !requestUrl) return null;
  const getOidc = async () => {
    const url = new URL(requestUrl);
    url.searchParams.set("audience", host);
    const response = await retry(() => send(url, { headers: { Authorization: `Bearer ${requestToken}` } }), {
      label: "GitHub OIDC request",
      isTransient: (result) => isTransientStatus(result.status),
      getDelayMs: retryAfterMs,
    });
    if (response.status !== 200) throw new Error(`GitHub OIDC request failed (HTTP ${response.status})`);
    return JSON.parse(response.body).value;
  };
  const minted = [];
  return {
    policy,
    async mint(repo) {
      const { token } = await exchange({ host, scope: repo, policy, ttl: "10m", getOidc, request: send, deadlineMs: Date.now() + STS_BUDGET_MS });
      console.log(`::add-mask::${token}`);
      minted.push(token);
      return token;
    },
    async revokeAll() {
      for (const token of minted.splice(0)) {
        await revokeToken(token, host).catch((error) => console.warn(`Could not revoke a source read token: ${error.message}`));
      }
    },
  };
}

// Reads skill sources through the GitHub REST API. A 404 from a repository
// the default token cannot see is retried once with an STS read token.
class GitHubSource {
  constructor({ token, minter = null, send = request, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com" }) {
    this.token = token;
    this.minter = minter;
    this.send = send;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.tokens = new Map();
  }

  async call(repo, path, accept = "application/vnd.github+json") {
    const attempt = (token) => retry(() => this.send(`${this.apiUrl}${path}`, {
      headers: {
        Accept: accept,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }), { label: `GET ${path}`, isTransient: (result) => isTransientStatus(result.status), getDelayMs: retryAfterMs });
    let response = await attempt(this.tokens.get(repo) ?? this.token);
    if (response.status === 404 && this.minter && !this.tokens.has(repo)) {
      this.tokens.set(repo, await this.minter.mint(repo));
      response = await attempt(this.tokens.get(repo));
    }
    if (response.status !== 200) {
      const hint = response.status === 404 && !this.tokens.has(repo)
        ? ` If ${repo} is private, add .github/sts/${this.minter?.policy ?? "skill-sync-read"}.sts.yaml to it and grant this job id-token: write.`
        : "";
      throw new Error(`GET ${path} failed (HTTP ${response.status}).${hint}`);
    }
    return response.body;
  }

  async json(repo, path) {
    return JSON.parse(await this.call(repo, path));
  }

  async resolve(repo, ref) {
    let label = ref;
    if (ref === "release") label = (await this.json(repo, `/repos/${repo}/releases/latest`)).tag_name;
    const commit = (await this.call(repo, `/repos/${repo}/commits/${encodePath(label)}`, "application/vnd.github.sha")).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${repo}@${label} did not resolve to a commit`);
    return { commit, label };
  }

  async blob(repo, sha) {
    const blob = await this.json(repo, `/repos/${repo}/git/blobs/${sha}`);
    return Buffer.from(blob.content, blob.encoding);
  }

  // A file path is distributed as SKILL.md; a directory is copied whole.
  // Symlinks and submodules are rejected rather than followed.
  async files(repo, commit, path) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const listing = await this.json(repo, `/repos/${repo}/contents/${encodePath(parent)}?ref=${commit}`);
    const entry = Array.isArray(listing) ? listing.find((item) => item.path === path) : undefined;
    if (!entry) throw new Error(`${repo}@${commit.slice(0, 8)}: ${path} does not exist`);
    if (entry.type === "file") return new Map([["SKILL.md", await this.blob(repo, entry.sha)]]);
    if (entry.type !== "dir") throw new Error(`${repo}/${path}: ${entry.type} entries are not copied`);
    const tree = await this.json(repo, `/repos/${repo}/git/trees/${entry.sha}?recursive=1`);
    if (tree.truncated) throw new Error(`${repo}/${path}: tree listing is truncated`);
    const files = new Map();
    for (const item of tree.tree) {
      if (item.type === "tree") continue;
      if (item.type !== "blob" || (item.mode !== "100644" && item.mode !== "100755")) {
        throw new Error(`${repo}/${path}/${item.path}: symlinks and submodules are not copied`);
      }
      files.set(item.path, await this.blob(repo, item.sha));
    }
    if (!files.has("SKILL.md")) throw new Error(`${repo}/${path} has no SKILL.md`);
    return files;
  }

  async text(repo, commit, path) {
    const entry = await this.json(repo, `/repos/${repo}/contents/${encodePath(path)}?ref=${commit}`);
    return (await this.blob(repo, entry.sha)).toString("utf8");
  }
}

module.exports = { GitHubSource, encodePath, stsMinter };
