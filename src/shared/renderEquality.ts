// Small equality helpers for the renderer's memoized components and store updates (pure, no React).

/** Same own keys and Object.is-equal values. */
export function shallowEqual(a: object | null | undefined, b: object | null | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && Object.is(ra[k], rb[k]));
}

/** True when applying `patch` to `current` would change at least one value. */
export function patchChanges<T extends object>(current: T, patch: Partial<T>): boolean {
  const c = current as Record<string, unknown>;
  return Object.entries(patch).some(([k, v]) => !Object.is(c[k], v));
}

/**
 * Props of a memoized component: equal when every prop is the same reference, except `style`, which is compared by its
 * values (the grid builds a fresh style object for each cell on every render).
 */
export function propsEqualWithStyle<P extends object>(prev: P, next: P): boolean {
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && (k === 'style'
    ? shallowEqual(a[k] as object | undefined, b[k] as object | undefined)
    : Object.is(a[k], b[k])));
}

