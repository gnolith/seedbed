import { execFileSync } from 'node:child_process';
import { chmod, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
await chmod('dist/cli.js', 0o755).catch(() => undefined);
