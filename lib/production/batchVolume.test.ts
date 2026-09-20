import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BREWHOUSE_BBL, batchFillBbl, expectedYieldBbl } from "./batchVolume";
import { TURN_BBL } from "@/lib/partner/capacity";

describe("batchFillBbl", () => {
  it("is the brewhouse size times whole turns", () => {
    expect(batchFillBbl(1)).toBe(20);
    expect(batchFillBbl(3)).toBe(60);
  });
  it("treats a missing or junk turn count as one turn", () => {
    expect(batchFillBbl(null)).toBe(20);
    expect(batchFillBbl(0)).toBe(20);
    expect(batchFillBbl(Number.NaN)).toBe(20);
  });
});

describe("expectedYieldBbl", () => {
  it("is the recipe's per-turn yield times turns", () => {
    expect(expectedYieldBbl(18, 2)).toBe(36);
  });
  it("forecasts no loss rather than inventing a yield", () => {
    expect(expectedYieldBbl(null, 2)).toBe(40);
  });
});

describe("one brewhouse size", () => {
  it("the partner portal quotes the same turn size", () => {
    expect(TURN_BBL).toBe(BREWHOUSE_BBL);
  });
  it("the DB trigger derives volume with the same number", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_batch_volume_is_brewhouse_fill.sql"))!;
    expect(readFileSync(join(dir, file), "utf8")).toContain(`new.volume_bbl := ${BREWHOUSE_BBL} * greatest`);
  });
});
