import { describe, it, expect, vi } from "vitest";
import { memoizeByRef } from "./memo";

describe("memoizeByRef", () => {
  it("computes once per distinct argument reference", () => {
    const fn = vi.fn((arr: number[]) => arr.reduce((a, b) => a + b, 0));
    const memo = memoizeByRef(fn);
    const arr = [1, 2, 3];

    expect(memo(arr)).toBe(6);
    expect(memo(arr)).toBe(6);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the identical cached object (reference equality)", () => {
    const memo = memoizeByRef((arr: number[]) => ({ sum: arr.reduce((a, b) => a + b, 0) }));
    const arr = [1, 2];
    const first = memo(arr);
    const second = memo(arr);
    expect(second).toBe(first);
  });

  it("recomputes for a different reference with equal contents", () => {
    const fn = vi.fn((arr: number[]) => arr.length);
    const memo = memoizeByRef(fn);
    const a = [1, 2, 3];
    const b = [1, 2, 3]; // structurally equal, different reference

    memo(a);
    memo(b);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps separate cache entries per argument", () => {
    const fn = vi.fn((arr: number[]) => arr.length);
    const memo = memoizeByRef(fn);
    const a = [1];
    const b = [1, 2];

    expect(memo(a)).toBe(1);
    expect(memo(b)).toBe(2);
    expect(memo(a)).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("works with object (non-array) keys", () => {
    const fn = vi.fn((obj: { n: number }) => obj.n * 2);
    const memo = memoizeByRef(fn);
    const key = { n: 5 };
    expect(memo(key)).toBe(10);
    expect(memo(key)).toBe(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // BUG: the cache uses `if (hit !== undefined)`, so a memoized function that
  // legitimately returns `undefined` is never cached — it is recomputed on
  // every call. This characterization test documents the current behavior.
  it("does NOT cache an undefined result (recomputes each call)", () => {
    const fn = vi.fn((_arr: number[]) => undefined);
    const memo = memoizeByRef(fn);
    const arr = [1, 2, 3];

    expect(memo(arr)).toBeUndefined();
    expect(memo(arr)).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2); // would be 1 if undefined were cached
  });

  it("caches falsy-but-defined results (0, empty string, false)", () => {
    const zero = vi.fn((_a: number[]) => 0);
    const memoZero = memoizeByRef(zero);
    const arr = [1];
    memoZero(arr);
    memoZero(arr);
    expect(zero).toHaveBeenCalledTimes(1);

    const empty = vi.fn((_a: object) => "");
    const memoEmpty = memoizeByRef(empty);
    const key = {};
    memoEmpty(key);
    memoEmpty(key);
    expect(empty).toHaveBeenCalledTimes(1);
  });
});
