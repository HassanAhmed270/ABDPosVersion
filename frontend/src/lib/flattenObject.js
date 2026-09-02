export function flattenObject(obj, prefix = '') {
  if (obj === null || obj === undefined) return [];
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [{ path: prefix, value: [] }];
    return obj.flatMap((item, i) => flattenObject(item, `${prefix}[${i}]`));
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return [{ path: prefix, value: {} }];
    return keys.flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return flattenObject(obj[key], path);
    });
  }
  return [{ path: prefix, value: obj }];
}

export function lastSegment(path) {
  const match = path.match(/([A-Za-z0-9_]+)(?:\[\d+\])?$/);
  return match ? match[1] : path;
}
