export function canonicalizeEsbuildMetafile(metafile) {
  const inputs = Object.fromEntries(Object.entries(metafile.inputs)
    .map(([path, input]) => {
      const { bytes: _physicalEolBytes, ...stableInput } = input;
      return [normalizePath(path), normalizeNode(stableInput)];
    })
    .sort(([left], [right]) => compare(left, right)));
  const outputs = Object.fromEntries(Object.entries(metafile.outputs)
    .map(([path, output]) => [normalizePath(path), normalizeNode(output)])
    .sort(([left], [right]) => compare(left, right)));
  return { inputs, outputs };
}

function normalizeNode(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => normalizeNode(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, child]) => [normalizePath(childKey), normalizeNode(child, childKey)])
      .sort(([left], [right]) => compare(left, right)));
  }
  if (typeof value === 'string' && (key === 'path' || key === 'entryPoint')) return normalizePath(value);
  return value;
}

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
