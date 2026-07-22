import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('zero-audit gate must run through npm');

const auditArguments = process.argv.includes('--full') ? ['audit', '--json'] : ['audit', '--omit=dev', '--json'];
const result = spawnSync(process.execPath, [npmCli, ...auditArguments], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30_000,
});
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error(`npm audit did not return bounded JSON (status ${result.status ?? 'none'})`);
}
const total = report.metadata?.vulnerabilities?.total;
if (result.error || result.signal || result.status !== 0 || total !== 0) {
  throw new Error(`production dependency audit failed closed (status ${result.status ?? 'none'}, total ${String(total)})`);
}
process.stdout.write(`${process.argv.includes('--full') ? 'full' : 'production'} dependency audit: 0 vulnerabilities\n`);
