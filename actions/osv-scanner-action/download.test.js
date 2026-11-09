const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

function fixture(t, name = 'asset.bin') {
  const bytes = Buffer.from('pinned native artifact\0\xff');
  const release = { repository: 'google/osv-scanner', version: 'v2.6.0',
    assets: { [name]: createHash('sha256').update(bytes).digest('hex') } };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osv download '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = `https://github.com/${release.repository}/releases/download/${release.version}/${name}`;
  const prefix = `https://api.github.com/repos/${release.repository}`;
  const metadataURL = `${prefix}/releases/tags/${release.version}`;
  const assetURL = `${prefix}/releases/assets/123`;
  const metadata = { tag_name: release.version, draft: false, assets: [{ name, id: 123, state: 'uploaded',
    size: bytes.length, url: assetURL, browser_download_url: primary }] };
  const calls = [], delays = [];
  const options = { fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers['accept-encoding'], 'identity');
    if (url === primary) return new Response('outage', { status: 504 });
    if (url === metadataURL) return Response.json(metadata);
    if (url === assetURL) return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    throw new Error(`Unexpected URL ${url}`);
  }, sleep: async delay => delays.push(delay) };
  return { bytes, release, directory, name, primary, metadataURL, assetURL, metadata, calls, delays, options };
}

function empty(f) { assert.deepEqual(fs.readdirSync(f.directory), []); }

// Incident cases: shared provenance on Linux, Darwin ARM64 scanner, Windows verifier provenance.
for (const name of ['multiple.intoto.jsonl', 'osv-scanner_darwin_arm64', 'slsa-verifier-windows-amd64.exe.intoto.jsonl']) {
  test(`504 fallback preserves pinned bytes for ${name}`, async t => {
    const { download } = await import('./install.mjs');
    const f = fixture(t, name);
    const result = await download(f.release, name, f.directory, f.options);
    assert.deepEqual(fs.readFileSync(result), f.bytes);
    assert.deepEqual(fs.readdirSync(f.directory), [name]);
    assert.deepEqual(f.calls.map(c => c.url), [f.primary, f.primary, f.primary, f.metadataURL, f.assetURL]);
    assert.deepEqual(f.delays, [1000, 2000]);
  });
}

test('direct success and valid cached files never call the API', async t => {
  const { download } = await import('./install.mjs');
  const f = fixture(t);
  f.options.fetch = async (url, options) => {
    assert.equal(url, f.primary); assert.equal(options.redirect, 'manual');
    return new Response(f.bytes);
  };
  await download(f.release, f.name, f.directory, f.options);
  f.options.fetch = () => assert.fail('cache hit must not download');
  await download(f.release, f.name, f.directory, f.options);
  fs.writeFileSync(path.join(f.directory, f.name), 'corrupt');
  await assert.rejects(download(f.release, f.name, f.directory, f.options), /Checksum mismatch/);
});

for (const status of [400, 401, 403, 404, 407, 409, 410, 416, 451, 501, 505, 206, 204]) {
  test(`HTTP ${status} refuses fallback and retry`, async t => {
    const { download } = await import('./install.mjs');
    const f = fixture(t); let calls = 0;
    f.options.fetch = async url => { calls++; assert.equal(url, f.primary); return new Response(null, { status }); };
    await assert.rejects(download(f.release, f.name, f.directory, f.options), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1); assert.deepEqual(f.delays, []); empty(f);
  });
}

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} is recoverable, with bounded retries`, async t => {
    const { download } = await import('./install.mjs');
    const f = fixture(t); const request = f.options.fetch;
    f.options.fetch = (url, options) => url === f.primary
      ? (f.calls.push({ url }), Promise.resolve(new Response(null, { status }))) : request(url, options);
    await download(f.release, f.name, f.directory, f.options);
    assert.equal(f.calls.filter(c => c.url === f.primary).length, 3);
    assert.equal(f.calls.filter(c => c.url === f.assetURL).length, 1);
  });
}

test('Retry-After seconds and dates are honored but cannot stall indefinitely', async t => {
  const { download, retryDelay } = await import('./install.mjs');
  const f = fixture(t); let calls = 0;
  f.options.fetch = async () => ++calls === 1
    ? new Response(null, { status: 429, headers: { 'retry-after': '3' } }) : new Response(f.bytes);
  await download(f.release, f.name, f.directory, f.options);
  assert.deepEqual(f.delays, [3000]);
  assert.equal(retryDelay(new Response(null, { status: 429, headers: { 'retry-after': '999999' } }), 0), 30000);
  assert.equal(retryDelay(new Response(null, { status: 429, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' } }), 0, 0), 5000);
});

for (const code of ['ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']) {
  test(`${code} reaches the official API after bounded retry`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch;
    f.options.fetch = async (url, options) => {
      if (url === f.primary) { f.calls.push({ url }); throw new TypeError('fetch failed', { cause: Object.assign(new Error('transport'), { code }) }); }
      return request(url, options);
    };
    await download(f.release, f.name, f.directory, f.options);
    assert.equal(f.calls.length, 5);
  });
}

for (const error of [new TypeError('unknown failure'), Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }),
  new TypeError('fetch failed', { cause: Object.assign(new Error('certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }),
  Object.assign(new Error('outer socket'), { code: 'UND_ERR_SOCKET', cause: Object.assign(new Error('proxy refused'), { code: 'PROXY_AUTH_REQUIRED' }) })]) {
  test(`security/unknown errors fail closed: ${error.message} ${error.code || ''}`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); let calls = 0;
    f.options.fetch = async () => { calls++; throw error; };
    await assert.rejects(download(f.release, f.name, f.directory, f.options), error);
    assert.equal(calls, 1); empty(f);
  });
}

for (const [label, mutate] of Object.entries({
  tag: m => { m.tag_name = 'v999'; }, draft: m => { m.draft = true; },
  missingDraft: m => { delete m.draft; }, missing: m => { m.assets = []; },
  duplicate: m => { m.assets.push(m.assets[0]); }, name: m => { m.assets[0].name += '.tar.gz'; },
  id: m => { m.assets[0].id = '123'; }, negativeID: m => { m.assets[0].id = -1; },
  unsafeID: m => { m.assets[0].id = Number.MAX_SAFE_INTEGER + 1; },
  state: m => { m.assets[0].state = 'new'; }, size: m => { m.assets[0].size = 0; },
  sizeLimit: m => { m.assets[0].size = 600 * 1024 * 1024; },
  repository: m => { m.assets[0].url = 'https://api.github.com/repos/evil/fork/releases/assets/123'; },
  browserURL: m => { m.assets[0].browser_download_url += '?other'; },
  foreignTag: m => { m.assets[0].browser_download_url = m.assets[0].browser_download_url.replace('v2.6.0', 'v2.5.0'); },
})) {
  test(`metadata rejects ${label} before fetching asset`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); mutate(f.metadata);
    await assert.rejects(download(f.release, f.name, f.directory, f.options), /identity mismatch/);
    assert.equal(f.calls.length, 4); empty(f);
  });
}

for (const body of ['<html>bad gateway</html>', '{"assets":', 'null', '[]']) {
  test(`malformed metadata fails closed: ${body}`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch;
    f.options.fetch = (url, options) => url === f.metadataURL
      ? new Response(body, { headers: { 'content-type': 'application/json' } }) : request(url, options);
    await assert.rejects(download(f.release, f.name, f.directory, f.options)); empty(f);
    assert.ok(!f.calls.some(c => c.url === f.assetURL));
  });
}

for (const target of ['http://release-assets.githubusercontent.com/file', 'https://evil.example/file',
  'https://release-assets.githubusercontent.com.evil.example/file', 'https://user:secret@release-assets.githubusercontent.com/file',
  'https://release-assets.githubusercontent.com:8443/file', 'https://api.github.com/repos/evil/file',
  'https://release-assets.githubusercontent.com/file#fragment']) {
  test(`unsafe redirect fails closed: ${target}`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); let calls = 0;
    f.options.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); };
    await assert.rejects(download(f.release, f.name, f.directory, f.options), /Unsafe download redirect/);
    assert.equal(calls, 1); empty(f);
  });
}

test('official asset redirects carry no workflow token or API-specific headers', async t => {
  const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch;
  const target = 'https://release-assets.githubusercontent.com/file?signature=not-logged';
  const old = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'secret-test-token';
  t.after(() => { if (old === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = old; });
  f.options.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.ok(!JSON.stringify(options.headers).includes('secret-test-token'));
    assert.ok(!Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)));
    if (url === f.assetURL) return new Response(null, { status: 302, headers: { location: target } });
    if (url === target) {
      assert.deepEqual(options.headers, { accept: '*/*', 'accept-encoding': 'identity' });
      return new Response(f.bytes);
    }
    return request(url, options);
  };
  await download(f.release, f.name, f.directory, f.options);
});

test('metadata redirects and endless asset redirects are refused', async t => {
  const { download } = await import('./install.mjs');
  for (const metadata of [true, false]) {
    const f = fixture(t); const request = f.options.fetch; let redirected = 0;
    f.options.fetch = (url, options) => {
      if (metadata ? url === f.metadataURL : url !== f.primary && url !== f.metadataURL) {
        redirected++;
        return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/loop' } });
      }
      return request(url, options);
    };
    await assert.rejects(download(f.release, f.name, f.directory, f.options), /Invalid download redirect/);
    assert.equal(redirected, metadata ? 1 : 6); empty(f);
  }
});

for (const fallback of [false, true]) {
  for (const [label, bytes] of [['modified binary', Buffer.from('evil')], ['unexpected archive', gzipSync('archive bytes')]]) {
    test(`${label} checksum failure never retries or falls back (${fallback ? 'API' : 'primary'})`, async t => {
      const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch; let bad = 0;
      if (fallback) f.metadata.assets[0].size = bytes.length;
      f.options.fetch = (url, options) => {
        if (url === (fallback ? f.assetURL : f.primary)) {
          bad++; return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
        }
        return request(url, options);
      };
      await assert.rejects(download(f.release, f.name, f.directory, f.options), /Checksum mismatch/);
      assert.equal(bad, 1); empty(f);
    });
  }
}

for (const [label, headers] of Object.entries({ range: { 'content-range': 'bytes 0-3/20' },
  badLength: { 'content-length': '-1' }, oversize: { 'content-length': String(600 * 1024 * 1024) },
  encoded: { 'content-encoding': 'gzip' } })) {
  test(`invalid response ${label} fails without fallback`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); let calls = 0;
    f.options.fetch = () => { calls++; return new Response(f.bytes, { headers }); };
    await assert.rejects(download(f.release, f.name, f.directory, f.options)); assert.equal(calls, 1); empty(f);
  });
}

test('API JSON masquerading as bytes and HTML masquerading as metadata are refused', async t => {
  const { download } = await import('./install.mjs');
  for (const metadata of [true, false]) {
    const f = fixture(t); const request = f.options.fetch;
    f.options.fetch = (url, options) => url === (metadata ? f.metadataURL : f.assetURL)
      ? new Response('{}', { headers: { 'content-type': metadata ? 'text/html' : 'application/json' } }) : request(url, options);
    await assert.rejects(download(f.release, f.name, f.directory, f.options), /content type/); empty(f);
  }
});

test('interrupted partial streams are removed before retry and API fallback', async t => {
  const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch; let failures = 0;
  f.options.fetch = (url, options) => {
    const files = fs.readdirSync(f.directory);
    assert.equal(files.length, 1, 'only current attempt temp file exists');
    assert.equal(fs.statSync(path.join(f.directory, files[0])).size, 0, 'each attempt starts empty');
    if (url === f.primary) {
      failures++; let chunk = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (!chunk) { chunk = true; controller.enqueue(Buffer.from('partial')); }
        else controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      } }));
    }
    return request(url, options);
  };
  // Metadata fetch has no temporary file: assert it independently.
  const wrapped = f.options.fetch;
  f.options.fetch = (url, options) => {
    if (url === f.metadataURL) { empty(f); return request(url, options); }
    return wrapped(url, options);
  };
  await download(f.release, f.name, f.directory, f.options);
  assert.equal(failures, 3); assert.deepEqual(fs.readdirSync(f.directory), [f.name]);
});

test('stalled headers and bodies abort and recover without partial files', async t => {
  const { download } = await import('./install.mjs');
  for (const body of [false, true]) {
    const f = fixture(t); const request = f.options.fetch; let aborted = 0;
    f.options.timeoutMs = 10;
    f.options.fetch = (url, options) => {
      if (url !== f.primary) return request(url, options);
      options.signal.addEventListener('abort', () => aborted++);
      if (!body) return new Promise(() => {});
      return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('partial')); } }));
    };
    await download(f.release, f.name, f.directory, f.options);
    assert.equal(aborted, 3); assert.deepEqual(fs.readdirSync(f.directory), [f.name]);
  }
});

test('API exhaustion leaves no artifact; metadata and API statuses use the same policy', async t => {
  const { download } = await import('./install.mjs');
  for (const target of ['metadataURL', 'assetURL']) for (const status of [403, 407, 504]) {
    const f = fixture(t); const request = f.options.fetch; let failures = 0;
    f.options.fetch = (url, options) => url === f[target]
      ? (failures++, new Response(null, { status })) : request(url, options);
    await assert.rejects(download(f.release, f.name, f.directory, f.options), new RegExp(`HTTP ${status}`));
    assert.equal(failures, status === 504 ? 3 : 1); empty(f);
  }
});

test('invalid input identity and missing checksum fail before any request', async t => {
  const { download } = await import('./install.mjs'); const f = fixture(t);
  f.options.fetch = () => assert.fail('invalid input must not fetch');
  await assert.rejects(download(f.release, '../escape', f.directory, f.options), /No pinned checksum/);
  f.release.repository = 'evil.example/path/repo';
  await assert.rejects(download(f.release, f.name, f.directory, f.options), /Invalid pinned release identity/);
  empty(f);
});

for (const mixed of [false, true]) {
  test(`multi-address connection failures ${mixed ? 'reject mixed security errors' : 'recover when every failure is transient'}`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch; let failures = 0;
    const aggregate = new AggregateError([
      Object.assign(new Error('IPv6 failed'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('IPv4 failed'), { code: mixed ? 'CERT_HAS_EXPIRED' : 'ETIMEDOUT' }),
    ], 'multiple connections failed');
    aggregate.code = 'ECONNREFUSED';
    f.options.fetch = (url, options) => {
      if (url === f.primary) { failures++; throw new TypeError('fetch failed', { cause: aggregate }); }
      return request(url, options);
    };
    if (mixed) {
      await assert.rejects(download(f.release, f.name, f.directory, f.options)); empty(f);
      assert.equal(failures, 1);
    } else {
      await download(f.release, f.name, f.directory, f.options);
      assert.equal(failures, 3);
    }
  });
}

for (const headers of [true, false]) {
  test(`API asset size is checked ${headers ? 'in headers' : 'after streaming'}`, async t => {
    const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch;
    f.metadata.assets[0].size++;
    f.options.fetch = (url, options) => url === f.assetURL
      ? new Response(f.bytes, { headers: { 'content-type': 'application/octet-stream',
        ...(headers ? { 'content-length': String(f.bytes.length) } : {}) } }) : request(url, options);
    await assert.rejects(download(f.release, f.name, f.directory, f.options), /size mismatch/); empty(f);
  });
}

test('a short declared body retries transport, never publishing partial content', async t => {
  const { download } = await import('./install.mjs'); const f = fixture(t); const request = f.options.fetch; let primary = 0;
  f.options.fetch = (url, options) => url === f.primary
    ? (primary++, new Response(f.bytes.subarray(0, 2), { headers: { 'content-length': String(f.bytes.length) } }))
    : request(url, options);
  await download(f.release, f.name, f.directory, f.options);
  assert.equal(primary, 3); assert.deepEqual(fs.readdirSync(f.directory), [f.name]);
});
