// lib/square/client.test.ts
//
// Tests the pure error-classification seam: SquareApiError.isNotFound and the
// isSquareNotFound(unknown) guard callers use to branch on a deleted resource
// (404 / NOT_FOUND) vs. a transient failure that should still throw.
import { describe, it, expect } from "vitest";
import { SquareApiError, isSquareNotFound } from "./client";

describe("SquareApiError.isNotFound", () => {
  it("is true for a 404 status", () => {
    expect(new SquareApiError(404, null, "gone").isNotFound).toBe(true);
  });

  it("is true when the Square error code is NOT_FOUND (even off a non-404 status)", () => {
    expect(new SquareApiError(400, "NOT_FOUND", "missing").isNotFound).toBe(true);
  });

  it("is false for other failures (auth, rate limit, server error)", () => {
    expect(new SquareApiError(401, "UNAUTHORIZED", "bad token").isNotFound).toBe(false);
    expect(new SquareApiError(429, "RATE_LIMITED", "slow down").isNotFound).toBe(false);
    expect(new SquareApiError(500, "INTERNAL_SERVER_ERROR", "oops").isNotFound).toBe(false);
  });
});

describe("isSquareNotFound", () => {
  it("matches a not-found SquareApiError", () => {
    expect(isSquareNotFound(new SquareApiError(404, "NOT_FOUND", "gone"))).toBe(true);
  });

  it("rejects a SquareApiError that is not a not-found", () => {
    expect(isSquareNotFound(new SquareApiError(500, "INTERNAL_SERVER_ERROR", "oops"))).toBe(false);
  });

  it("rejects non-SquareApiError values (plain Error, string, null)", () => {
    expect(isSquareNotFound(new Error("404 not found"))).toBe(false);
    expect(isSquareNotFound("NOT_FOUND")).toBe(false);
    expect(isSquareNotFound(null)).toBe(false);
    expect(isSquareNotFound(undefined)).toBe(false);
  });
});
