const crypto = require("node:crypto");
const http = require("node:http");
const { createGitHubOIDC } = require("./github-oidc.cjs");

function createTokenServer(token, getOIDC = createGitHubOIDC()) {
  if (typeof token !== "string" || !/^\S{20,4096}$/.test(token)) throw new Error("Socket token is invalid");
  const route = `/${crypto.randomBytes(32).toString("base64url")}`;
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== route) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const timer = setTimeout(() => request.destroy(), 1_000);
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1024) { request.destroy(); return; }
        chunks.push(chunk);
      }
      clearTimeout(timer);
      const body = Buffer.concat(chunks).toString("utf8");
      const options = body ? JSON.parse(body) : {};
      // Empty legacy POSTs return immediately without contacting GitHub.
      const jwt = await getOIDC(options?.github_oidc_audience);
      response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
      response.end(JSON.stringify({ token, ...(jwt ? { github_oidc_jwt: jwt } : {}) }));
    } catch {
      response.writeHead(400, { "Cache-Control": "no-store" });
      response.end();
    } finally {
      clearTimeout(timer);
    }
  });
  return { server, route };
}

if (require.main === module) process.once("message", (message) => {
  const token = message && message.token;
  if (typeof token !== "string" || !/^\S{20,4096}$/.test(token)) process.exit(1);
  const { server, route } = createTokenServer(token, createGitHubOIDC(message.oidc));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(1);
    if (process.send) process.send({ url: `http://127.0.0.1:${address.port}${route}` });
  });
});

module.exports = { createTokenServer };
