const HOSTS = new Set(["gh-sts.tempoxyz.net", "gh-sts.tehq.dev"]);

function host(value) {
  if (HOSTS.has(value)) return value;
  throw new Error("host must be gh-sts.tempoxyz.net or gh-sts.tehq.dev");
}

module.exports = { host };
