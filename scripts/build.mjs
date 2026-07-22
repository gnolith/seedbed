import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { canonicalizeEsbuildMetafile } from './canonicalize-esbuild-metafile.mjs';

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
const result = await build({
  entryPoints: ['src/mcp.ts'],
  outfile: 'dist/mcp.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'eof',
  treeShaking: true,
  metafile: true,
});
await writeFile('dist/mcp.meta.json', `${JSON.stringify(canonicalizeEsbuildMetafile(result.metafile), null, 2)}\n`);
