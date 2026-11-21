// Extension pages share Web Locks. The queue also supports local test contexts without the API.
const pending = new Map();

export function withStorageLock(key, operation) {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(key, operation);
  const result = (pending.get(key) || Promise.resolve()).then(operation);
  pending.set(key, result.catch(() => {}));
  return result;
}
