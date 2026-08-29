const MAX_TTL_MS = 60 * 60 * 1000;

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

function parseTtl(value) {
  const match = /^([1-9][0-9]*)([smh])$/.exec(value);
  if (!match) {
    throw new Error("ttl must be a positive duration with an s, m, or h suffix");
  }
  const ttlMs = Number(match[1]) * UNIT_MS[match[2]];
  if (!Number.isSafeInteger(ttlMs) || ttlMs > MAX_TTL_MS) {
    throw new Error("ttl must not exceed 1h");
  }
  return ttlMs;
}

module.exports = { MAX_TTL_MS, parseTtl };
