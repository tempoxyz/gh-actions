const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const helper = fs.readFileSync(path.join(__dirname, 'download-release.sh'), 'utf8');
const pins = {
  actionlint: ['8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8', '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6'],
  mold: ['6ff270c9bf07d2bec5c98aa324eb7c4daf6a1a4d815c05ff1708049616047855', '16b025652d3d7456689e6025a77e1903bb2a15e7630877c26cc133f5df95b9c6'],
};
const installers = [
  ['actions/setup-pinact/action.yml', 'pinact'],
  ['actions/actionlint/action.yml', 'actionlint'],
  ['actions/scan-github-actions/action.yml', 'actionlint'],
  ['actions/setup-mold/action.yml', 'mold'],
  ['actions/setup-rust-build/action.yml', 'mold'],
  ['.github/workflows/rust-clippy.yml', 'mold'],
  ['.github/workflows/rust-build-binaries.yml', 'mold'],
  ['.github/workflows/scan-github-actions.yml', 'pinact'],
  ['.github/workflows/scan-github-actions.yml', 'actionlint'],
];

function step(file, tool) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const title = `- name: Install ${tool}${tool === 'mold' ? ' linker' : ''}`;
  const start = text.indexOf(title);
  assert.notEqual(start, -1);
  const tail = text.slice(start);
  const run = /^( +)run: \|[^\n]*\n/m.exec(tail);
  assert.ok(run);
  const indent = run[1].length + 2;
  const lines = tail.slice(run.index + run[0].length).split('\n');
  const script = [];
  for (const line of lines) {
    if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
    script.push(line.slice(indent));
  }
  return { script: script.join('\n'), prefix: tail.slice(0, run.index), text };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['bin', 'payload', 'runner']) fs.mkdirSync(path.join(directory, name));
  for (const tool of ['pinact', 'actionlint', 'mold']) fs.writeFileSync(`${directory}/payload/${tool}`, '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  const archive = `${directory}/archive`;
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', `${directory}/payload`, 'pinact', 'actionlint', 'mold']).status, 0);
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${directory}/options.json`, JSON.stringify(options));
  let source = helper;
  if (options.shortWatchdog) source = source.replace('SECONDS - progress_at >= 60', 'SECONDS - progress_at >= 2').replace('i < 5', 'i < 1');
  fs.writeFileSync(`${directory}/helper.sh`, source);
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.FIXTURE;
const o = JSON.parse(fs.readFileSync(root + '/options.json'));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls', JSON.stringify({command, args, host: process.env.GH_HOST}) + '\\n');
if (command === 'uname') { console.log(o.arch ?? 'x86_64'); process.exit(0); }
if (command === 'id') { console.log('0'); process.exit(0); }
if (command === 'realpath') { console.log('/usr/local/bin/mold'); process.exit(0); }
if (command === 'mold') { console.log('fixture'); process.exit(0); }
if (command === 'tar') {
  if (args.includes('/usr/local')) process.exit(0); // Never install mold on the host.
  const r = spawnSync('/usr/bin/tar', args, {stdio: 'inherit'}); process.exit(r.status);
}
const payload = name => name.endsWith('_checksums.txt')
  ? Buffer.from((o.badChecksum ? '0'.repeat(64) : '${digest}') + '  pinact_linux_' + (o.arch === 'aarch64' ? 'arm64' : 'amd64') + '.tar.gz\\n')
  : (o.corrupt ? Buffer.from('corrupt') : fs.readFileSync(root + '/archive'));
if (command === 'curl') {
  const name = args.at(-1).split('/').at(-1);
  const dest = args[args.indexOf('-o') + 1];
  if (o.fail === 'all' || o.fail === name) {
    fs.writeFileSync(dest, 'partial-error');
    process.stdout.write(String(o.http ?? 504).padStart(3, '0') + ' ' + String(o.proxy ?? 0).padStart(3, '0'));
    process.exit(o.curlStatus ?? 22);
  }
  fs.writeFileSync(dest, payload(name)); process.stdout.write('200 200'); process.exit(0);
}
if (command === 'gh') {
  if (args[0] === 'attestation') process.exit(o.attestationFailure ? 1 : 0);
  if (args.some(x => x.includes('/releases/tags/'))) {
    if (o.metadataFailure) process.exit(1);
    const query = args.at(-1);
    if (o.ids !== undefined) { process.stdout.write(o.ids); process.exit(0); }
    if (o.wrongTag || o.wrongName || o.draft) process.exit(0);
    const name = /select\\(\\.name == "([^"]+)"\\)/.exec(query)[1];
    const id = name.endsWith('_checksums.txt') ? '102' : '101';
    fs.writeFileSync(root + '/' + id, name); console.log(id); process.exit(0);
  }
  fs.writeFileSync(root + '/api-pid', String(process.pid));
  fs.writeFileSync(root + '/supervisor-pid', String(process.ppid));
  if (o.apiStall) {
    if (o.ignoreTerm) process.on('SIGTERM', () => fs.writeFileSync(root + '/api-term', 'received'));
    if (o.termExitZero) process.on('SIGTERM', () => process.exit(0));
    if (!o.noInitialBytes) process.stdout.write('initial');
    setInterval(() => {}, 1000); return;
  }
  if (o.apiFailure) { process.stdout.write('partial-api'); process.exit(1); }
  const bytes = payload(fs.readFileSync(root + '/' + args.at(-1).split('/').at(-1), 'utf8'));
  if (o.apiSlow) {
    let offset = 0; const width = Math.ceil(bytes.length / 10);
    const timer = setInterval(() => { process.stdout.write(bytes.subarray(offset, offset + width)); offset += width; if (offset >= bytes.length) { clearInterval(timer); process.exit(0); } }, 400);
    return;
  }
  process.stdout.write(bytes); process.exit(0);
}
process.exit(99);
`;
  for (const command of ['curl', 'gh', 'uname', 'tar', 'id', 'realpath', 'mold']) fs.writeFileSync(`${directory}/bin/${command}`, shim, { mode: 0o755 });
  const env = { ...process.env, FIXTURE: directory, PATH: `${directory}/bin:${process.env.PATH}`, RUNNER_TEMP: `${directory}/runner`, GITHUB_PATH: `${directory}/path`, GH_HOST: 'untrusted.invalid', MAKE_DEFAULT: 'false', VERSION: options.version ?? 'v5.0.1' };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const run = (repository = 'rhysd/actionlint', tag = 'v1.7.12', asset = 'actionlint_1.7.12_linux_amd64.tar.gz') => spawnSync('bash', ['-c', 'source "$1"; download_release "$2" "$3" "$4" "$5"', 'test', `${directory}/helper.sh`, repository, tag, asset, `${directory}/result`], { env, encoding: 'utf8', timeout: 15000 });
  const install = (file, tool, overrides = {}) => {
    const block = step(file, tool);
    const variables = {};
    for (const match of block.prefix.matchAll(/^ +([A-Z_0-9]+): (.+)$/gm)) if (!match[2].includes('${{')) variables[match[1]] = match[2].replace(/^"|"$/g, '');
    let script = block.script;
    // A fixture digest replaces only literals in this disposable copy; production pins have a separate contract.
    for (const pin of pins[tool] ?? []) script = script.replaceAll(pin, digest);
    for (const key of Object.keys(variables)) if ((pins[tool] ?? []).includes(variables[key])) variables[key] = digest;
    if (options.shortWatchdog) script = script.replace('SECONDS - progress_at >= 60', 'SECONDS - progress_at >= 2').replace('i < 5', 'i < 1');
    const filename = `${directory}/install.sh`;
    fs.writeFileSync(filename, script);
    return spawnSync('bash', [filename], { cwd: directory, env: { ...env, ...variables, ...overrides, GITHUB_ACTION_PATH: path.join(root, path.dirname(file)) }, encoding: 'utf8', timeout: 20000 });
  };
  const calls = () => fs.existsSync(`${directory}/calls`) ? fs.readFileSync(`${directory}/calls`, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const notInstalled = () => { assert.equal(fs.existsSync(`${directory}/path`), false); assert.equal(calls().some(c => ['tar', 'mold'].includes(c.command)), false); };
  const clean = () => { assert.equal(fs.existsSync(`${directory}/result`), false); assert.equal(fs.readdirSync(directory).some(name => name.startsWith('result.')), false); };
  const stopped = () => assert.throws(() => process.kill(Number(fs.readFileSync(`${directory}/api-pid`, 'utf8')), 0), { code: 'ESRCH' });
  return { directory, run, install, calls, notInstalled, clean, stopped, env };
}

test('generated workflow copies and all installer shell syntax are current', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'sync.js'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  let embedded = 0;
  for (const [file, tool] of installers) {
    const { script, prefix, text } = step(file, tool);
    assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0, file);
    assert.match(prefix, /GH_TOKEN: \$\{\{ github.token \}\}/);
    if (file.startsWith('actions/')) assert.match(script, /source "\$GITHUB_ACTION_PATH\/\.\.\/download-release\/download-release.sh"/);
    else { embedded++; assert.ok(script.includes(helper.replace(/^#![^\n]*\n/, '').trimEnd())); assert.doesNotMatch(script, /source |GITHUB_ACTION_PATH/); }
    if (tool === 'pinact') {
      assert.match(text, /v5\.0\.1/);
      assert.match(prefix, /GH_HOST: github.com/);
      assert.match(script, /--repo suzuki-shunsuke\/pinact/);
      assert.match(script, /--signer-workflow suzuki-shunsuke\/go-release-workflow\/\.github\/workflows\/release.yaml/);
      assert.match(script, /--source-ref "refs\/tags\/\$\{(?:PINACT_)?VERSION\}"/);
    } else {
      for (const digest of pins[tool]) assert.ok((prefix + script).includes(digest), `${file}: ${digest}`);
      assert.ok((prefix + script).includes(tool === 'mold' ? '2.42.1' : '1.7.12'));
    }
    assert.ok(script.indexOf('sha256sum') < script.indexOf('tar -'));
  }
  assert.equal(embedded, 4);
});

for (const [file, tool] of installers) for (const fail of [undefined, 'all']) {
  test(`${file} ${tool}: ${fail ? '504 fallback' : 'normal'} verifies before install`, t => {
    const f = fixture(t, { fail });
    const result = f.install(file, tool);
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const metadata = calls.filter(c => c.args.some(x => x.includes('/releases/tags/')));
    assert.equal(metadata.length, fail ? (tool === 'pinact' ? 2 : 1) : 0);
    for (const c of metadata) {
      assert.deepEqual(c.args.slice(0, 3), ['api', '--hostname', 'github.com']);
      assert.match(c.args.at(-1), /^select\(\.tag_name == "[^"/]+" and \.draft == false\) \| \.assets\[\] \| select\(\.name == "[^"/]+"\) \| \.id$/);
      assert.match(c.args[3], /^repos\/(suzuki-shunsuke\/pinact|rhysd\/actionlint|rui314\/mold)\/releases\/tags\/v/);
    }
    if (tool === 'pinact') {
      const index = calls.findIndex(c => c.args[0] === 'attestation');
      assert.ok(index >= 0 && index < calls.findIndex(c => c.command === 'tar'));
      assert.equal(calls[index].host, 'github.com');
      assert.deepEqual(calls[index].args.slice(3), ['--repo', 'suzuki-shunsuke/pinact', '--signer-workflow', 'suzuki-shunsuke/go-release-workflow/.github/workflows/release.yaml', '--source-ref', 'refs/tags/v5.0.1']);
    }
  });
}

for (const [file, tool] of installers) {
  test(`${file} ${tool}: corrupt fallback bytes never extract or execute`, t => {
    const f = fixture(t, { fail: 'all', corrupt: true });
    assert.notEqual(f.install(file, tool).status, 0); f.notInstalled();
  });
}

for (const file of ['actions/setup-pinact/action.yml', '.github/workflows/scan-github-actions.yml']) for (const fail of [undefined, 'all']) for (const failure of ['badChecksum', 'attestationFailure']) {
  test(`${file}: ${failure}, ${fail ?? 'normal'} transport fails closed`, t => {
    const f = fixture(t, { fail, [failure]: true });
    assert.notEqual(f.install(file, 'pinact').status, 0); f.notInstalled();
    assert.equal(f.calls().filter(c => c.command === 'curl').length, 2);
    assert.equal(f.calls().filter(c => c.args[0] === 'attestation').length, failure === 'badChecksum' ? 0 : 1);
  });
}

for (const [curlStatus, http, proxy = 0] of [[22,403],[22,404],[22,407],[22,410],[22,501],[60,0],[35,0],[23,200],[47,302],[56,0,403],[56,302,407],[56,302,302],[28,401],[18,404],[60,302]]) {
  test(`curl ${curlStatus}, HTTP ${http}, CONNECT ${proxy}: no fallback`, t => {
    const f = fixture(t, { fail: 'all', curlStatus, http, proxy });
    assert.notEqual(f.run().status, 0); assert.equal(f.calls().some(c => c.command === 'gh'), false); f.clean();
  });
}
for (const [curlStatus, http, proxy = 0] of [[22,408],[22,429],[22,500],[22,502],[22,503],[22,504],[6,0],[7,302,200],[18,200],[28,307,200],[52,0],[55,200],[56,302,200]]) {
  test(`curl ${curlStatus}, HTTP ${http}, CONNECT ${proxy}: recovers exact asset`, t => {
    const f = fixture(t, { fail: 'all', curlStatus, http, proxy });
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(`${f.directory}/result`), fs.readFileSync(`${f.directory}/archive`));
    const asset = f.calls().find(c => c.args.some(x => x.includes('/releases/assets/')));
    assert.deepEqual(asset.args, ['api', '--hostname', 'github.com', '-H', 'Accept: application/octet-stream', 'repos/rhysd/actionlint/releases/assets/101']);
  });
}
for (const options of [{ids:''},{ids:'1\n2\n'},{ids:'0'},{ids:'https://evil.invalid'},{wrongTag:true},{wrongName:true},{draft:true},{metadataFailure:true},{apiFailure:true}]) {
  test(`bad API identity/transport ${JSON.stringify(options)} preserves old destination`, t => {
    const f = fixture(t, { fail: 'all', ...options });
    fs.writeFileSync(`${f.directory}/result`, 'previous');
    assert.notEqual(f.run().status, 0);
    assert.equal(fs.readFileSync(`${f.directory}/result`, 'utf8'), 'previous');
    assert.equal(fs.readdirSync(f.directory).some(name => name.startsWith('result.')), false);
  });
}

test('input validation rejects repository, tag and asset injection before requests', t => {
  const f = fixture(t);
  for (const args of [['evil/repo'], ['rhysd/actionlint','v1/other'], ['rhysd/actionlint','v1','asset" | .id']]) assert.notEqual(f.run(...args).status, 0);
  assert.equal(f.calls().length, 0);
});

test('primary attempts bound connection/stalls/retries without a total transfer cutoff', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const args = f.calls()[0].args;
  for (const [flag, value] of [['--proto','=https'],['--proto-redir','=https'],['--connect-timeout','10'],['--speed-limit','1024'],['--speed-time','60'],['--retry','3'],['--retry-max-time','180']]) assert.equal(args[args.indexOf(flag)+1], value);
  assert.ok(!args.includes('--max-time'));
  assert.match(helper, /timeout --kill-after=5s 30s gh api --hostname github.com/);
});

test('progressing API stream can exceed inactivity deadline', t => {
  const f = fixture(t, { fail:'all', apiSlow:true, shortWatchdog:true });
  const started = Date.now(); const result = f.run();
  assert.equal(result.status, 0, result.stderr); assert.ok(Date.now() - started > 2000); f.stopped();
  assert.deepEqual(fs.readFileSync(`${f.directory}/result`), fs.readFileSync(`${f.directory}/archive`));
});
for (const options of [{},{ignoreTerm:true},{noInitialBytes:true},{termExitZero:true}]) {
  test(`stalled API stream is killed, reaped and cleaned ${JSON.stringify(options)}`, t => {
    const f = fixture(t, { fail:'all', apiStall:true, shortWatchdog:true, ...options });
    const result = f.run(); assert.equal(result.status, 124, result.stderr); f.clean(); f.stopped();
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} to supervisor during stream cleans owned child even with repeated cancellation`, async t => {
    const f = fixture(t, { fail:'all', apiStall:true, shortWatchdog:true, ignoreTerm:true });
    const child = spawn('bash', ['-c', 'source "$1"; download_release rhysd/actionlint v1.7.12 archive "$2"', 'test', `${f.directory}/helper.sh`, `${f.directory}/result`], { env:f.env, stdio:'ignore' });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    for (const marker of ['supervisor-pid','api-term']) {
      const end = Date.now()+5000;
      while (!fs.existsSync(`${f.directory}/${marker}`) && Date.now()<end) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(`${f.directory}/${marker}`), marker);
      const pid = Number(fs.readFileSync(`${f.directory}/supervisor-pid`, 'utf8'));
      process.kill(pid, marker === 'supervisor-pid' ? signal : 'SIGTERM');
    }
    assert.deepEqual(await exited, {code:signal === 'SIGINT' ? 130 : 143, signal:null});
    f.clean(); f.stopped();
  });
}

test('sync refuses missing generated boundaries instead of silently accepting stale copies', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'download-sync-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  fs.mkdirSync(`${directory}/actions/download-release`, {recursive:true});
  fs.mkdirSync(`${directory}/.github/workflows`, {recursive:true});
  for (const name of ['sync.js','download-release.sh']) fs.copyFileSync(path.join(__dirname,name), `${directory}/actions/download-release/${name}`);
  for (const name of ['rust-clippy','rust-build-binaries','scan-github-actions']) fs.copyFileSync(`${root}/.github/workflows/${name}.yml`, `${directory}/.github/workflows/${name}.yml`);
  const file = `${directory}/.github/workflows/rust-clippy.yml`;
  fs.writeFileSync(file, fs.readFileSync(file,'utf8').replace('# BEGIN generated download-release helper', '# missing boundary'));
  const result = spawnSync(process.execPath,[`${directory}/actions/download-release/sync.js`,'--check'],{encoding:'utf8'});
  assert.notEqual(result.status,0); assert.match(result.stderr,/Missing download helper boundaries/);
});
