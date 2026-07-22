import { describe, expect, it } from "vitest";
import { getCanonFrom, seedFallbackClient } from "./getCanon";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

type FakeResult = { data: { document: BrandCanon }[] | null; error: unknown };

function fakeClient(result: FakeResult) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                limit() {
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("getCanonFrom", () => {
  it("returns the row's document when the client returns a row", async () => {
    const customCanon: BrandCanon = { ...seedCanon, brandName: "TestBrand" };
    const client = fakeClient({ data: [{ document: customCanon }], error: null });
    const result = await getCanonFrom(client as never);
    expect(result.brandName).toBe("TestBrand");
  });

  it("falls back to seedCanon when the client returns no rows", async () => {
    const client = fakeClient({ data: [], error: null });
    const result = await getCanonFrom(client as never);
    expect(result).toEqual(seedCanon);
  });

  it("falls back to seedCanon when data is null", async () => {
    const client = fakeClient({ data: null, error: null });
    const result = await getCanonFrom(client as never);
    expect(result).toEqual(seedCanon);
  });

  it("falls back to seedCanon when the client throws", async () => {
    const client = {
      from() {
        return {
          select() {
            throw new Error("boom");
          },
        };
      },
    };
    const result = await getCanonFrom(client as never);
    expect(result).toEqual(seedCanon);
  });

  it("falls back to seedCanon when the query returns an error", async () => {
    const client = fakeClient({ data: null, error: new Error("query failed") });
    const result = await getCanonFrom(client as never);
    expect(result).toEqual(seedCanon);
  });

  it("returns seedCanon when given the seedFallbackClient stub", async () => {
    const result = await getCanonFrom(seedFallbackClient);
    expect(result).toEqual(seedCanon);
  });
});
