const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const workflows = ['rust-clippy', 'rust-build-binaries', 'scan-github-actions'];
const helper = fs.readFileSync(path.join(__dirname, 'download-release.sh'), 'utf8').replace(/^#![^\n]*\n/, '').trimEnd();
for (const workflow of workflows) {
  const file = path.join(root, '.github/workflows', `${workflow}.yml`);
  const original = fs.readFileSync(file, 'utf8');
  const expected = workflow === 'scan-github-actions' ? 2 : 1;
  const boundaries = original.match(/^ +# (?:BEGIN|END) generated download-release helper$/gm) ?? [];
  if (boundaries.length !== expected * 2) throw new Error(`Missing download helper boundaries: ${file}`);
  let count = 0;
  const updated = original.replace(/^( +)# BEGIN generated download-release helper\n[\s\S]*?^\1# END generated download-release helper/gm,
    (_, indent) => { count++; return `${indent}# BEGIN generated download-release helper\n${helper.split('\n').map(line => line ? indent + line : '').join('\n')}\n${indent}# END generated download-release helper`; });
  if (count !== expected) throw new Error(`Malformed download helper boundaries: ${file}`);
  if (original === updated) continue;
  if (process.argv.includes('--check')) {
    console.error(`Stale download helper: ${path.relative(root, file)}; run node actions/download-release/sync.js`);
    process.exitCode = 1;
  } else fs.writeFileSync(file, updated);
}
