import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runFoundationDemo } from './demo.js';

const keep = process.argv.includes('--keep');
const directory = await mkdtemp(join(tmpdir(), 'aether-demo-'));
const report = await runFoundationDemo(directory);
const reportPath = resolve('readiness-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
for (const item of report.checks) console.log(`${item.status === 'pass' ? 'PASS' : 'FAIL'}  ${item.id.padEnd(20)} ${item.detail}`);
console.log(`\n${report.passed ? 'READY' : 'NOT READY'} — report: ${reportPath}${keep ? `, work directory: ${directory}` : ''}`);
if (!keep) await rm(directory, { recursive: true, force: true });
process.exitCode = report.passed ? 0 : 1;
