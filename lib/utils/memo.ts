// Memoize a pure function of a single object argument, keyed by reference.
//
// Catalog-derived indexes (price maps, keg index, combo index, …) are rebuilt
// from the full item list on every call. The Sales Pulse route runs the taproom
// model once for the period and again per day, all against the *same* catalog
// array — so without this the same O(catalog) indexes are rebuilt N+1 times.
// A WeakMap keyed on the array reference collapses that to one build, and the
// entry is GC'd when the array is.
export function memoizeByRef<A extends object, R>(fn: (arg: A) => R): (arg: A) => R {
  const cache = new WeakMap<A, R>();
  return (arg: A): R => {
    const hit = cache.get(arg);
    if (hit !== undefined) return hit;
    const val = fn(arg);
    cache.set(arg, val);
    return val;
  };
}
