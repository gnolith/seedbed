import { describe, expect, it } from 'vitest';
import { decodeOpaqueOwnerValue, encodeOpaqueOwnerValue } from '../docker/opaque-codec.mjs';

describe('opaque owner codec', () => {
  it('round-trips portable package values without understanding owner fields', () => {
    const value = {
      owner: 'package-owned',
      payload: new Uint8Array([0, 1, 2, 255]),
      rows: [{ id: 1n, enabled: true }, null],
      optional: undefined,
    };
    const bytes = encodeOpaqueOwnerValue(value);
    expect(decodeOpaqueOwnerValue(bytes)).toEqual({
      owner: 'package-owned',
      payload: new Uint8Array([0, 1, 2, 255]),
      rows: [{ enabled: true, id: 1n }, null],
    });
    expect(encodeOpaqueOwnerValue(value)).toEqual(bytes);
  });

  it('rejects malformed, noncanonical, and structurally unbounded values', () => {
    expect(() => encodeOpaqueOwnerValue({ value: Number.NaN })).toThrow(/safe integers/u);
    expect(() => encodeOpaqueOwnerValue({ nested: { value: 1 } }, { maxDepth: 1 })).toThrow(/structural/u);
    expect(() => decodeOpaqueOwnerValue(new TextEncoder().encode('[5,\"Zh==\"]'))).toThrow(/byte node/u);
    expect(() => decodeOpaqueOwnerValue(new TextEncoder().encode('[7,[[\"b\",[0]],[\"a\",[0]]]]'))).toThrow(/noncanonical/u);
  });
});
