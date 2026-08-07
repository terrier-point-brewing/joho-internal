// Retirement payload for taproom_recipe_settings. Shared by the settings route
// and the tap-swap queue route, which retires the outgoing beer when a swap is
// queued — so the two callers can never drift on what "retired" writes.
import { describe, it, expect } from "vitest";
import { buildRetirePayload } from "./retireRecipe";

const NOW = "2026-07-24T18:30:00.000Z";

describe("buildRetirePayload", () => {
  it("stamps retired_at when retiring", () => {
    const p = buildRetirePayload("recipe-1", true, NOW);
    expect(p).toEqual({
      recipe_id: "recipe-1",
      is_retired: true,
      retired_at: NOW,
      retired_notes: null,
    });
  });

  it("clears retired_at when un-retiring", () => {
    const p = buildRetirePayload("recipe-1", false, NOW);
    expect(p.is_retired).toBe(false);
    expect(p.retired_at).toBeNull();
  });

  it("passes notes through", () => {
    expect(buildRetirePayload("r", true, NOW, "seasonal done").retired_notes).toBe("seasonal done");
  });

  it("normalizes an empty-string note to null", () => {
    // Preserves the settings route's original `body.retired_notes || null`.
    expect(buildRetirePayload("r", true, NOW, "").retired_notes).toBeNull();
  });

  it("normalizes an omitted note to null", () => {
    expect(buildRetirePayload("r", true, NOW).retired_notes).toBeNull();
  });

  it("normalizes an explicit null note to null", () => {
    expect(buildRetirePayload("r", false, NOW, null).retired_notes).toBeNull();
  });

  it("leaves updated_at to the database trigger", () => {
    // taproom_recipe_settings carries a BEFORE INSERT OR UPDATE trigger that
    // stamps updated_at, so sending one from here would just be overwritten.
    // `nowIso` is still the caller's clock for retired_at, which is a business
    // fact rather than a row-write time.
    expect(buildRetirePayload("r", true, NOW)).not.toHaveProperty("updated_at");
    expect(buildRetirePayload("r", false, NOW)).not.toHaveProperty("updated_at");
  });
});
