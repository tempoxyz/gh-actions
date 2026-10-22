const DEFAULT_BROKER_HOST = "cf-deployer.tempoxyz.net";
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function brokerHost(raw) {
  const host = raw || DEFAULT_BROKER_HOST;
  if (!HOSTNAME.test(host)) {
    throw new Error("host must be a lowercase DNS hostname");
  }
  return host;
}

function brokerEndpoint(raw) {
  return new URL(`https://${brokerHost(raw)}`);
}

function brokerAudience(raw) {
  return brokerHost(raw);
}

module.exports = {
  DEFAULT_BROKER_HOST,
  brokerAudience,
  brokerEndpoint,
  brokerHost,
};
