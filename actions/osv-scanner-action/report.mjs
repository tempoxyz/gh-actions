import { writeFileSync } from 'node:fs';
import { isAbsolute, relative, win32 } from 'node:path';

const packageKey = pkg => JSON.stringify([pkg.name, pkg.version, pkg.ecosystem, pkg.commit]);
const sourceKey = source => JSON.stringify([source.path, source.type]);

export function validateResults(data) {
  if (!data || !Object.hasOwn(data, 'results') || (data.results !== null && !Array.isArray(data.results))) throw new Error('Invalid OSV results');
  for (const source of data.results || []) {
    if (!source.source || typeof source.source.path !== 'string' || !Array.isArray(source.packages)) throw new Error('Invalid OSV source');
    for (const entry of source.packages) {
      if (!entry.package || typeof entry.package.name !== 'string' ||
          (entry.vulnerabilities != null && !Array.isArray(entry.vulnerabilities))) throw new Error('Invalid OSV package');
      for (const vuln of entry.vulnerabilities || []) {
        if (typeof vuln.id !== 'string' || !vuln.id ||
            (vuln.aliases != null && !Array.isArray(vuln.aliases))) throw new Error('Invalid OSV vulnerability');
      }
    }
  }
  return data;
}

// Match upstream's reporter: first check whether any advisory occurrence count
// increased (a moved lockfile alone should not fail), then compare source,
// package/version, and advisory ID. Keep OSV's JSON shape for downstream users.
export function diffResults(oldData, newData) {
  validateResults(oldData); validateResults(newData);
  const counts = data => {
    const map = new Map();
    for (const source of data.results || []) for (const entry of source.packages) {
      for (const vuln of entry.vulnerabilities || []) map.set(vuln.id, (map.get(vuln.id) || 0) + 1);
    }
    return map;
  };
  const oldCounts = counts(oldData);
  if (![...counts(newData)].some(([id, count]) => count > (oldCounts.get(id) || 0))) return { results: [] };
  const old = new Map();
  for (const source of oldData.results || []) for (const entry of source.packages) {
    old.set(`${sourceKey(source.source)}:${packageKey(entry.package)}`, new Set((entry.vulnerabilities || []).map(v => v.id)));
  }
  const results = [];
  for (const source of newData.results || []) {
    const packages = [];
    for (const entry of source.packages) {
      const previous = old.get(`${sourceKey(source.source)}:${packageKey(entry.package)}`);
      const vulnerabilities = (entry.vulnerabilities || []).filter(v => !previous?.has(v.id));
      if (!vulnerabilities.length) continue;
      const ids = new Set(vulnerabilities.map(v => v.id));
      const groups = (entry.groups || []).map(group => ({ ...group, ids: group.ids.filter(id => ids.has(id)) })).filter(group => group.ids.length);
      packages.push({ ...entry, vulnerabilities, groups });
    }
    if (packages.length) results.push({ ...source, packages });
  }
  return { results };
}

export function sourcePath(file, workspace) {
  const paths = win32.isAbsolute(file) && /^[A-Za-z]:/.test(file) ? win32 : { isAbsolute, relative };
  const result = paths.isAbsolute(file) ? paths.relative(workspace, file) : file;
  if (!result || result === '..' || result.startsWith('../') || result.startsWith('..\\') || paths.isAbsolute(result)) return undefined;
  return result.replaceAll('\\', '/');
}

const markdown = value => String(value ?? '').replace(/[&<>|`\r\n]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '\r': ' ', '\n': ' ' })[c]);
const commandEscape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const propertyEscape = value => commandEscape(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

export function makeReport(diff, workspace, failOnVuln) {
  const findings = [];
  for (const source of diff.results) for (const entry of source.packages) for (const vuln of entry.vulnerabilities) {
    const group = entry.groups?.find(group => group.ids.includes(vuln.id));
    const severity = group?.max_severity || vuln.database_specific?.severity || 'unknown';
    const fixed = new Set();
    for (const affected of vuln.affected || []) {
      if (affected.package?.name !== entry.package.name || affected.package?.ecosystem !== entry.package.ecosystem) continue;
      for (const range of affected.ranges || []) for (const event of range.events || []) if (event.fixed) fixed.add(event.fixed);
    }
    findings.push({ id: vuln.id, package: entry.package.name, version: entry.package.version || entry.package.commit || '',
      ecosystem: entry.package.ecosystem || '', severity, fixed: [...fixed].join(', ') || 'unknown',
      summary: vuln.summary || vuln.id, path: sourcePath(source.source.path, workspace) });
  }
  const rows = findings.map(f => `| ${markdown(f.package)} | ${markdown(f.version)} | [${markdown(f.id)}](https://osv.dev/vulnerability/${encodeURIComponent(f.id)}) | ${markdown(f.severity)} | ${markdown(f.fixed)} | ${markdown(f.path || '')} |`);
  const summary = ['## Dependency Scan', '', findings.length ? `${findings.length} newly introduced advisory occurrence(s).` : 'No newly introduced vulnerabilities.', '',
    ...(findings.length ? ['| Package | Version | Advisory | Severity | Fixed versions | Source |', '|---|---|---|---|---|---|', ...rows, ''] : [])].join('\n');
  const rules = [...new Map(findings.map(f => [f.id, { id: f.id, shortDescription: { text: f.summary }, helpUri: `https://osv.dev/vulnerability/${encodeURIComponent(f.id)}` }])).values()];
  const sarif = { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{
    tool: { driver: { name: 'Dependency Scan', informationUri: 'https://github.com/tempoxyz/gh-actions', rules } },
    results: findings.map(f => ({ ruleId: f.id, level: failOnVuln ? 'error' : 'warning',
      message: { text: `${f.package}@${f.version}: ${f.summary} (${f.id})` },
      ...(f.path ? { locations: [{ physicalLocation: { artifactLocation: { uri: f.path.split('/').map(encodeURIComponent).join('/'), uriBaseId: '%SRCROOT%' } } }] } : {}),
    })),
  }] };
  const annotations = findings.map(f => `::${failOnVuln ? 'error' : 'warning'}${f.path ? ` file=${propertyEscape(f.path)}` : ''}::${commandEscape(`${f.package}@${f.version}: ${f.id} — ${f.summary}`)}`);
  return { summary, sarif, annotations, found: findings.length > 0 };
}

export function writeReport(directory, diff, workspace, failOnVuln) {
  const report = makeReport(diff, workspace, failOnVuln);
  for (const [name, value] of [['diff.json', JSON.stringify(diff, null, 2)], ['results.sarif', JSON.stringify(report.sarif, null, 2)], ['summary.md', report.summary]]) {
    writeFileSync(`${directory}/${name}`, `${value}\n`);
  }
  return report;
}
