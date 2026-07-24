export interface OpaqueCodecLimits {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export function encodeOpaqueOwnerValue(value: unknown, limits?: OpaqueCodecLimits): Uint8Array;
export function decodeOpaqueOwnerValue(bytes: Uint8Array, limits?: OpaqueCodecLimits): unknown;
