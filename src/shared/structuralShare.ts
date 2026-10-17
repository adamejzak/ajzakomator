// Structural sharing for plain JSON-like data (the app state): parts of `next` that are deep-equal to `prev` are replaced by
// the objects of `prev`, so selectors and memoized components see the same references when nothing they read changed.

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Returns `next`, with every sub-tree that equals the matching sub-tree of `prev` taken from `prev`. When everything
 * equals, `prev` itself is returned (the caller can skip the update). Only arrays and plain objects are walked; other
 * values are compared with Object.is. Keys present with `undefined` and missing keys count as different.
 */
export function shareStructure<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const shared = i < prev.length ? shareStructure(prev[i], item) : item;
      if (shared !== prev[i]) same = false;
      return shared;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const has = Object.prototype.hasOwnProperty.call(prev, key);
      const shared = has ? shareStructure(prev[key], next[key]) : next[key];
      if (!has || shared !== prev[key]) same = false;
      out[key] = shared;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
