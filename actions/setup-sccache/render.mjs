import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const downloader = fs.readFileSync(path.join(here, 'download-release.sh'), 'utf8').replace(/^#![^\n]*\n/, '').trimEnd();
const prepare = fs.readFileSync(path.join(here, 'prepare.sh'), 'utf8').replace(/^#![^\n]*\n/, '').trimEnd()
  .replace('bash "${ACTION_PATH:?}/download-release.sh"', 'download_release')
  .replace('bash "$ACTION_PATH/download-release.sh"', 'download_release');
// Subshells preserve the download helper's exit and cleanup traps without exiting preparation.
const script = `download_release() (\n${downloader}\n)\n${prepare}\n`;
const block = script.trimEnd().split('\n').map(line => line ? `          ${line}` : '').join('\n');
const begin = '          # BEGIN GENERATED sccache transport (actions/setup-sccache/render.mjs)';
const end = '          # END GENERATED sccache transport';
for (const relative of ['.github/workflows/rust-clippy.yml', '.github/workflows/rust-build-binaries.yml']) {
  const filename = path.join(root, relative);
  const previous = fs.readFileSync(filename, 'utf8');
  const start = previous.indexOf(begin);
  const finish = previous.indexOf(end, start);
  if (start === -1 || finish === -1) throw new Error(`Missing generated block in ${relative}`);
  const rendered = previous.slice(0, start) + begin + '\n' + block + '\n' + end + previous.slice(finish + end.length);
  if (process.argv.includes('--check')) {
    if (rendered !== previous) throw new Error(`Run node actions/setup-sccache/render.mjs to update ${relative}`);
  } else fs.writeFileSync(filename, rendered);
}
