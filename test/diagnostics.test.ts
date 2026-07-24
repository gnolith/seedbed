import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseInstallation } from '../src/diagnostics.js';
import { fixtureConfig, mockPorts } from './helpers.js';

describe('bounded read-only Docker-local diagnostics', () => {
  it('reports owner/Compose/selector evidence without mutations or remote/project diagnosis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seedbed-doctor-'));
    const config = fixtureConfig(root);
    const ports = mockPorts(config);
    let mutations = 0;
    const compose = {
      async prepare() { mutations++; },
      async up() { mutations++; },
      async health() { return { healthy: false }; },
      async downRetainData() { mutations++; },
    };
    const host = {
      async inspect() {
        return {
          dockerCli: { available: true, version: '28.0.0' },
          dockerEngine: { available: true, version: '28.0.0' },
          compose: { available: true, version: '2.39.0' },
        };
      },
      async reachable() { return false; },
    };
    const report = await diagnoseInstallation({ config, ports, compose, host });
    expect(report.mutationsPerformed).toBe(false);
    expect(mutations).toBe(0);
    expect(report.compose.endpoint).toBe('http://127.0.0.1:4317/mcp');
    expect(report).not.toHaveProperty('codex');
    expect(report).not.toHaveProperty('remote');
    expect(report.issues.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(report)).not.toContain('A'.repeat(43));
  });
});
