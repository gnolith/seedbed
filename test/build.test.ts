import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeEsbuildMetafile } from '../scripts/canonicalize-esbuild-metafile.mjs';

describe('stdio bundle metadata', () => {
  it('normalizes only physical EOL byte counts and path serialization', () => {
    const variant = (bytes: number, separator: '\\' | '/') => ({
      inputs: {
        [`src${separator}mcp.ts`]: {
          bytes,
          imports: [{ path: `node_modules${separator}zod${separator}index.js`, kind: 'import-statement' }],
          format: 'esm',
        },
      },
      outputs: {
        [`dist${separator}mcp.js`]: {
          imports: [],
          exports: ['createMcpServer'],
          entryPoint: `src${separator}mcp.ts`,
          inputs: { [`src${separator}mcp.ts`]: { bytesInOutput: 123 } },
          bytes: 456,
        },
      },
    });
    const lf = canonicalizeEsbuildMetafile(variant(100, '/'));
    const crlf = canonicalizeEsbuildMetafile(variant(120, '\\'));
    const mixed = canonicalizeEsbuildMetafile(variant(111, '/'));
    expect(crlf).toEqual(lf);
    expect(mixed).toEqual(lf);
    expect(lf.inputs['src/mcp.ts']).not.toHaveProperty('bytes');
    expect(lf.outputs['dist/mcp.js']).toMatchObject({ bytes: 456, inputs: { 'src/mcp.ts': { bytesInOutput: 123 } } });
    expect(createHash('sha256').update(JSON.stringify(lf)).digest('hex'))
      .toBe(createHash('sha256').update(JSON.stringify(crlf)).digest('hex'));
  });
});
