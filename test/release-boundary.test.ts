import { describe, expect, it, vi } from 'vitest';
import {
  classifyGhcrVersions,
  classifyGitHubRelease,
  classifyNpmVersion,
  requestJson,
  validateTagEvidence,
} from '../scripts/release-preflight.mjs';

const npmExpected = { name: '@gnolith/seedbed', version: '0.2.0', integrity: 'sha512-exact' };

describe('release remote preflights', () => {
  it('rejects lightweight, wrong-commit, non-main, and version-mismatched tags', () => {
    const commit = 'a'.repeat(40);
    const valid = {
      tag: 'v0.2.0', objectType: 'tag', peeledCommit: commit,
      checkoutCommit: commit, eventCommit: commit, mainAncestor: true, packageVersion: '0.2.0',
    };
    expect(validateTagEvidence(valid)).toEqual({ version: '0.2.0', commit });
    for (const change of [
      { objectType: 'commit' },
      { checkoutCommit: 'b'.repeat(40) },
      { eventCommit: 'c'.repeat(40) },
      { mainAncestor: false },
      { packageVersion: '0.2.1' },
      { tag: 'release-0.2.0' },
    ]) expect(() => validateTagEvidence({ ...valid, ...change })).toThrow();
  });

  it('accepts only absent or exact npm versions', () => {
    expect(classifyNpmVersion(404, {}, npmExpected)).toEqual({ state: 'absent' });
    expect(classifyNpmVersion(200, {
      name: npmExpected.name,
      version: npmExpected.version,
      dist: { integrity: npmExpected.integrity, attestations: { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } },
    }, npmExpected)).toEqual({ state: 'match' });
    for (const [status, body] of [
      [201, {}], [403, {}], [500, {}],
      [200, { ...npmExpected, dist: { integrity: 'sha512-wrong' } }],
    ] as const) expect(() => classifyNpmVersion(status, body, npmExpected)).toThrow();
  });

  it('accepts only absent or uniquely tagged GHCR versions', () => {
    expect(classifyGhcrVersions(404, {}, '0.2.0')).toEqual({ state: 'absent' });
    expect(classifyGhcrVersions(200, [{ id: 7, metadata: { container: { tags: ['0.2.0'] } } }], '0.2.0'))
      .toEqual({ state: 'match', id: 7, latestVersion: null });
    expect(classifyGhcrVersions(200, [{ id: 8, metadata: { container: { tags: ['0.1.1', 'latest'] } } }], '0.2.0'))
      .toEqual({ state: 'absent', latestVersion: '0.1.1' });
    expect(() => classifyGhcrVersions(200, {}, '0.2.0')).toThrow();
    expect(() => classifyGhcrVersions(403, [], '0.2.0')).toThrow();
    expect(() => classifyGhcrVersions(500, [], '0.2.0')).toThrow();
    expect(() => classifyGhcrVersions(200, Array.from({ length: 100 }, (_, id) => ({ id })), '0.2.0')).toThrow();
    expect(() => classifyGhcrVersions(200, [{ id: 3, metadata: { container: { tags: ['latest'] } } }], '0.2.0')).toThrow();
    expect(() => classifyGhcrVersions(200, [
      { id: 1, metadata: { container: { tags: ['0.2.0'] } } },
      { id: 2, metadata: { container: { tags: ['0.2.0'] } } },
    ], '0.2.0')).toThrow();
  });

  it('accepts only absent or immutable exact GitHub Releases', () => {
    expect(classifyGitHubRelease(404, {}, { tag: 'v0.2.0' })).toEqual({ state: 'absent' });
    expect(classifyGitHubRelease(200, { id: 9, tag_name: 'v0.2.0', draft: false, prerelease: false, immutable: true }, { tag: 'v0.2.0' }))
      .toEqual({ state: 'match', id: 9 });
    expect(classifyGitHubRelease(200, { id: 10, tag_name: 'v0.2.0', draft: true, prerelease: false, immutable: false }, { tag: 'v0.2.0' }))
      .toEqual({ state: 'draft', id: 10 });
    for (const body of [
      { tag_name: 'v9.9.9', immutable: true },
      { tag_name: 'v0.2.0', draft: true, immutable: true },
      { tag_name: 'v0.2.0', immutable: false },
    ]) expect(() => classifyGitHubRelease(200, body, { tag: 'v0.2.0' })).toThrow();
    expect(() => classifyGitHubRelease(403, {}, { tag: 'v0.2.0' })).toThrow();
    expect(() => classifyGitHubRelease(503, {}, { tag: 'v0.2.0' })).toThrow();
  });

  it('bounds malformed, timeout, and network failures without reflecting secrets', async () => {
    const response = (status: number, text: string) => ({ status, text: vi.fn(async () => text) });
    await expect(requestJson('https://example.test', { fetchImpl: vi.fn(async () => response(200, '{')) }))
      .rejects.toThrow('malformed JSON');
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array((1024 * 1024) + 1));
        controller.close();
      },
    });
    await expect(requestJson('https://example.test', {
      fetchImpl: vi.fn(async () => ({ status: 200, body: oversized })),
    })).rejects.toThrow('exceeded 1 MiB');
    await expect(requestJson('https://example.test', {
      timeoutMs: 5,
      fetchImpl: vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('secret-timeout-token')));
      })),
    })).rejects.toThrow('timed out');
    await expect(requestJson('https://example.test', { fetchImpl: vi.fn(async () => { throw new Error('secret-network-token'); }) }))
      .rejects.toThrow('request failed');
    for (const secret of ['secret-timeout-token', 'secret-network-token']) {
      await expect(requestJson('https://example.test', { fetchImpl: vi.fn(async () => { throw new Error(secret); }) }))
        .rejects.not.toThrow(secret);
    }
  });
});
