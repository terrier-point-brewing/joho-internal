import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireDateRange, apiError } from "./api";

function req(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

describe("requireDateRange", () => {
  it("returns {start,end} when both params are present", () => {
    const out = requireDateRange(req("https://x.test/api?start=2026-06-01&end=2026-06-30"));
    expect(out).toEqual({ start: "2026-06-01", end: "2026-06-30" });
  });

  it("returns a 400 NextResponse when start is missing", async () => {
    const out = requireDateRange(req("https://x.test/api?end=2026-06-30"));
    expect(out).toBeInstanceOf(NextResponse);
    const res = out as NextResponse;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "start and end required" });
  });

  it("returns a 400 NextResponse when end is missing", async () => {
    const out = requireDateRange(req("https://x.test/api?start=2026-06-01"));
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(400);
  });

  it("returns a 400 NextResponse when both are missing", async () => {
    const out = requireDateRange(req("https://x.test/api"));
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(400);
  });

  // BUG: empty-string params are falsy, so `?start=&end=` is rejected as
  // "missing" rather than treated as a present-but-invalid range. Also, no
  // date-format validation is performed — any non-empty string passes through.
  it("treats empty-string params as missing (400)", async () => {
    const out = requireDateRange(req("https://x.test/api?start=&end="));
    expect(out).toBeInstanceOf(NextResponse);
    expect((out as NextResponse).status).toBe(400);
  });

  it("passes through any non-empty strings without format validation", () => {
    const out = requireDateRange(req("https://x.test/api?start=garbage&end=also-garbage"));
    expect(out).toEqual({ start: "garbage", end: "also-garbage" });
  });

  it("uses the first occurrence of a repeated param", () => {
    const out = requireDateRange(
      req("https://x.test/api?start=2026-01-01&start=2026-02-02&end=2026-03-03"),
    );
    expect(out).toEqual({ start: "2026-01-01", end: "2026-03-03" });
  });
});

describe("apiError", () => {
  it("defaults to status 500", async () => {
    const res = apiError(new Error("boom"));
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  it("honors an explicit status code", async () => {
    const res = apiError("nope", 422);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  it("uses the message of an Error instance", async () => {
    const res = apiError(new Error("db down"));
    expect(await res.json()).toEqual({ error: "db down" });
  });

  it("uses a string error directly", async () => {
    const res = apiError("plain string error");
    expect(await res.json()).toEqual({ error: "plain string error" });
  });

  it("surfaces the `message` of a non-Error object (e.g. PostgrestError)", async () => {
    const res = apiError({ message: "row not found", code: "PGRST116" });
    expect(await res.json()).toEqual({ error: "row not found" });
  });

  it("falls back to String() for objects without a string message", async () => {
    const res = apiError({ code: 500 });
    expect(await res.json()).toEqual({ error: "[object Object]" });
  });

  it("falls back to String() for null", async () => {
    const res = apiError(null);
    expect(await res.json()).toEqual({ error: "null" });
  });

  it("falls back to String() for a numeric error", async () => {
    const res = apiError(42);
    expect(await res.json()).toEqual({ error: "42" });
  });

  it("treats a non-string `message` field via String() fallback", async () => {
    const res = apiError({ message: 123 });
    expect(await res.json()).toEqual({ error: "[object Object]" });
  });
});
