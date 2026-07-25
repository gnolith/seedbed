const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeOpaqueOwnerValue(value, limits = {}) {
  const state = boundedState(limits);
  const encoded = encodeNode(value, state, 0);
  const bytes = textEncoder.encode(JSON.stringify(encoded));
  if (bytes.byteLength > state.maxBytes) throw new TypeError('Opaque owner value exceeds the byte bound');
  return bytes;
}

export function decodeOpaqueOwnerValue(bytes, limits = {}) {
  const state = boundedState(limits);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > state.maxBytes) {
    throw new TypeError('Opaque owner bytes are invalid or exceed the byte bound');
  }
  let parsed;
  try {
    const json = textDecoder.decode(bytes);
    parsed = JSON.parse(json);
    if (JSON.stringify(parsed) !== json) {
      throw new TypeError('Opaque owner bytes are not canonical JSON');
    }
  } catch (error) {
    throw new TypeError('Opaque owner bytes are not canonical UTF-8 JSON', { cause: error });
  }
  return decodeNode(parsed, state, 0);
}

function encodeNode(value, state, depth) {
  countNode(state, depth);
  if (value === null) return [0];
  if (typeof value === 'boolean') return [1, value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('Opaque owner numbers must be finite safe integers');
    }
    return [2, value];
  }
  if (typeof value === 'string') return [3, value];
  if (typeof value === 'bigint') return [4, value.toString(10)];
  if (value instanceof ArrayBuffer) return [5, Buffer.from(value).toString('base64')];
  if (ArrayBuffer.isView(value)) {
    return [5, Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')];
  }
  if (Array.isArray(value)) return [6, value.map((entry) => encodeNode(entry, state, depth + 1))];
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Opaque owner values must contain only plain objects');
    }
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, encodeNode(entry, state, depth + 1)]);
    return [7, entries];
  }
  throw new TypeError(`Unsupported opaque owner value: ${typeof value}`);
}

function decodeNode(node, state, depth) {
  countNode(state, depth);
  if (!Array.isArray(node) || node.length < 1 || !Number.isSafeInteger(node[0])) {
    throw new TypeError('Opaque owner node is invalid');
  }
  switch (node[0]) {
    case 0:
      exactLength(node, 1);
      return null;
    case 1:
      exactLength(node, 2);
      if (typeof node[1] !== 'boolean') throw new TypeError('Opaque boolean node is invalid');
      return node[1];
    case 2:
      exactLength(node, 2);
      if (!Number.isSafeInteger(node[1])) throw new TypeError('Opaque number node is invalid');
      return node[1];
    case 3:
      exactLength(node, 2);
      if (typeof node[1] !== 'string') throw new TypeError('Opaque string node is invalid');
      return node[1];
    case 4:
      exactLength(node, 2);
      if (typeof node[1] !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/u.test(node[1])) {
        throw new TypeError('Opaque bigint node is invalid');
      }
      return BigInt(node[1]);
    case 5:
      exactLength(node, 2);
      if (typeof node[1] !== 'string' || !canonicalBase64(node[1])) {
        throw new TypeError('Opaque byte node is invalid');
      }
      return Uint8Array.from(Buffer.from(node[1], 'base64'));
    case 6:
      exactLength(node, 2);
      if (!Array.isArray(node[1])) throw new TypeError('Opaque array node is invalid');
      return node[1].map((entry) => decodeNode(entry, state, depth + 1));
    case 7: {
      exactLength(node, 2);
      if (!Array.isArray(node[1])) throw new TypeError('Opaque object node is invalid');
      const output = Object.create(null);
      let previous = null;
      for (const pair of node[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length === 0) {
          throw new TypeError('Opaque object entry is invalid');
        }
        if (previous !== null && previous.localeCompare(pair[0]) >= 0) {
          throw new TypeError('Opaque object keys are duplicated or noncanonical');
        }
        previous = pair[0];
        output[pair[0]] = decodeNode(pair[1], state, depth + 1);
      }
      return output;
    }
    default:
      throw new TypeError('Opaque owner node tag is unsupported');
  }
}

function boundedState(limits) {
  const maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
  const maxDepth = limits.maxDepth ?? 100;
  const maxNodes = limits.maxNodes ?? 1_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError('Opaque owner codec bounds are invalid');
  }
  return { maxBytes, maxDepth, maxNodes, nodes: 0 };
}

function countNode(state, depth) {
  state.nodes += 1;
  if (depth > state.maxDepth || state.nodes > state.maxNodes) {
    throw new TypeError('Opaque owner value exceeds structural bounds');
  }
}

function exactLength(node, expected) {
  if (node.length !== expected) throw new TypeError('Opaque owner node has unknown fields');
}

function canonicalBase64(value) {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}
