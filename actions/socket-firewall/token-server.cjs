const crypto = require("node:crypto");
const http = require("node:http");

process.once("message", (message) => {
  const token = message && message.token;
  if (typeof token !== "string" || !/^\S{20,4096}$/.test(token)) process.exit(1);
  const route = `/${crypto.randomBytes(32).toString("base64url")}`;
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== route) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
    response.end(JSON.stringify({ token }));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(1);
    if (process.send) process.send({ url: `http://127.0.0.1:${address.port}${route}` });
  });
});
