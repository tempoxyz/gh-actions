import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const attempts = 3;
const assetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const transientCodes = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

export function verifyChecksum(bytes, expected, name) {
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Checksum mismatch: ${name}`);
}

export function retryDelay(response, attempt, now = Date.now()) {
  const value = response.headers?.get('retry-after');
  const seconds = value === null || value === undefined || value.trim() === '' ? NaN : Number(value);
  const date = Date.parse(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000
    : Number.isFinite(date) ? Math.max(0, date - now) : 1_000 * 2 ** attempt;
  return response.status === 429 ? Math.min(delay, 30_000) : 1_000 * 2 ** attempt;
}

class TransportError extends Error {
  constructor(message, delay) { super(message); this.delay = delay; }
}

function recoverable(error) {
  // An outer socket failure must not hide a certificate or proxy/security error.
  if (error instanceof TransportError) return true;
  const pending = [error];
  const seen = new Set();
  let transport = false;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (current.code) {
      if (!transientCodes.has(current.code)) return false;
      transport = true;
    }
    if (current.cause) pending.push(current.cause);
    if (current.errors !== undefined) {
      if (!Array.isArray(current.errors) || current.errors.length === 0) return false;
      pending.push(...current.errors);
    }
    if (!current.code && !current.cause && current.errors === undefined) return false;
  }
  return transport;
}

async function bounded(fn, controller, timeoutMs) {
  let timer;
  try {
    return await Promise.race([fn(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new TransportError('Download made no progress before timeout');
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function response(url, { request, timeoutMs, metadata = false, api = false, attempt }) {
  const controller = new AbortController();
  try {
    for (let redirects = 0; ; redirects++) {
      // Public artifacts need no credential. Never read workflow tokens, even on api.github.com.
      const headers = { accept: api ? 'application/octet-stream' : metadata ? 'application/vnd.github+json' : '*/*',
        'accept-encoding': 'identity' };
      if (new URL(url).hostname === 'api.github.com') headers['x-github-api-version'] = '2022-11-28';
      const result = await bounded(() => request(url, { headers, redirect: 'manual', signal: controller.signal }), controller, timeoutMs);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        await result.body?.cancel();
        if (metadata || redirects >= 5) throw new Error('Invalid download redirect');
        const location = result.headers.get('location');
        if (!location) throw new Error('Missing download redirect location');
        const target = new URL(location, url);
        if (target.protocol !== 'https:' || target.username || target.password || target.port || target.hash || !assetHosts.has(target.hostname))
          throw new Error('Unsafe download redirect');
        url = target.href;
        api = false;
        continue;
      }
      if (result.status !== 200) {
        await result.body?.cancel();
        const message = `Download: HTTP ${result.status}`;
        if ([408, 429, 500, 502, 503, 504].includes(result.status)) throw new TransportError(message, retryDelay(result, attempt));
        throw new Error(message);
      }
      if (!result.body || result.headers.has('content-range')) throw new Error('Invalid download response');
      if (metadata && !/^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(result.headers.get('content-type') || ''))
        throw new Error('Invalid release metadata content type');
      // An asset API that ignores Accept can return JSON metadata with HTTP 200.
      if (api && !/^application\/octet-stream(?:;|$)/i.test(result.headers.get('content-type') || ''))
        throw new Error('Invalid release asset content type');
      return { controller, result };
    }
  } catch (error) {
    controller.abort();
    throw error;
  }
}

async function consume(url, options, onChunk, limit, expectedSize) {
  const { controller, result } = await response(url, options);
  let reader;
  try {
    const length = result.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit))
      throw new Error('Invalid download content length');
    if (length !== null && expectedSize !== undefined && Number(length) !== expectedSize)
      throw new Error('Release asset size mismatch');
    const encoding = result.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') throw new Error('Unexpected download content encoding');
    reader = result.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await bounded(() => reader.read(), controller, options.timeoutMs);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Download exceeds size limit');
      onChunk(value);
    }
    if (length !== null && size !== Number(length)) throw new TransportError('Incomplete download');
    if (expectedSize !== undefined && size !== expectedSize) throw new Error('Release asset size mismatch');
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
}

async function retry(fn, sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(attempt); }
    catch (error) {
      if (!recoverable(error) || attempt === attempts - 1) throw error;
      await sleep(error.delay ?? 1_000 * 2 ** attempt);
    }
  }
}

export async function download(release, name, directory, {
  fetch: request = fetch, sleep = delay => new Promise(resolve => setTimeout(resolve, delay)), timeoutMs = 60_000,
} = {}) {
  const expected = release.assets[name];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`No pinned checksum for ${name}`);
  if (typeof release.repository !== 'string' || !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(release.repository) ||
      typeof release.version !== 'string' || !/^[a-zA-Z0-9][\w.-]*$/.test(release.version) ||
      !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid pinned release identity');
  const path = join(directory, name);
  if (existsSync(path)) {
    verifyChecksum(readFileSync(path), expected, name);
    return path;
  }
  const url = `https://github.com/${release.repository}/releases/download/${release.version}/${name}`;
  const options = { request, timeoutMs };
  const save = async (source, extra = {}, size) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, 'wx', 0o700);
      const hash = createHash('sha256');
      await consume(source, { ...options, ...extra }, chunk => {
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset);
      }, size ?? 512 * 1024 * 1024, size);
      if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${name}`);
      closeSync(fd); fd = undefined;
      renameSync(temporary, path);
      return path;
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  };
  try { return await retry(attempt => save(url, { attempt }), sleep); }
  catch (error) { if (!recoverable(error)) throw error; }
  console.warn(`OSV download: ${name} transport retries exhausted; trying the official GitHub release asset API`);

  // Resolve the pinned tag, not latest, and accept exactly one uploaded asset.
  const prefix = `https://api.github.com/repos/${release.repository}`;
  const metadata = await retry(async attempt => {
    const chunks = [];
    await consume(`${prefix}/releases/tags/${release.version}`, { ...options, attempt, metadata: true },
      chunk => chunks.push(chunk), 4 * 1024 * 1024);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }, sleep);
  if (!metadata || metadata.tag_name !== release.version || metadata.draft !== false || !Array.isArray(metadata.assets))
    throw new Error('Release metadata identity mismatch');
  const assets = metadata.assets.filter(asset => asset?.name === name);
  const asset = assets[0];
  if (assets.length !== 1 || !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024 ||
      asset.url !== `${prefix}/releases/assets/${asset.id}` || asset.browser_download_url !== url)
    throw new Error('Release asset identity mismatch');
  return retry(attempt => save(`${prefix}/releases/assets/${asset.id}`, { attempt, api: true }, asset.size), sleep);
}
