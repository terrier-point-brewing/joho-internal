/**
 * The collector is what stands between one broken query and a Home page that
 * says "all clear" — or a digest that never arrives. These pin the three
 * promises: sources are filtered by grants before they run, a throwing source
 * becomes a visible error rather than a missing group, and the order the
 * dashboard shows is the order the registry declares.
 */
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectAlerts, countItems, filterGroupsForGrants, sortItems } from "./collect";
import type { AlertItem, AlertSource } from "./types";
import { CAP } from "@/lib/auth/capabilities";
import { ROOT } from "@/lib/auth/scopes";

const admin = {} as SupabaseClient;

function source(over: Partial<AlertSource> & Pick<AlertSource, "key">): AlertSource {
  return {
    label: over.key,
    section: "production",
    href: "/x",
    requires: CAP.exportRead,
    load: async () => [],
    ...over,
  };
}

const item = (over: Partial<AlertItem> = {}): AlertItem => ({
  key: "k", title: "t", href: "/", severity: "info", ...over,
});

describe("collectAlerts", () => {
  it("runs only the sources the grants can open, and runs none for a viewer", async () => {
    const exportLoad = vi.fn(async () => [item({ key: "a" })]);
    const taxLoad = vi.fn(async () => [item({ key: "b" })]);
    const sources = [
      source({ key: "exports", requires: CAP.exportRead, load: exportLoad }),
      source({ key: "tax", section: "finance", requires: CAP.taxRead, load: taxLoad }),
    ];

    const brewer = await collectAlerts(admin, { grants: { "production.export": "operate" }, sources });
    expect(brewer.map((g) => g.key)).toEqual(["exports"]);
    expect(taxLoad).not.toHaveBeenCalled();

    const viewer = await collectAlerts(admin, { grants: { "taproom.access": "read" }, sources });
    expect(viewer).toEqual([]);
    expect(exportLoad).toHaveBeenCalledTimes(1);

    const root = await collectAlerts(admin, { grants: { [ROOT]: "admin" }, sources });
    expect(root.map((g) => g.key)).toEqual(["exports", "tax"]);
  });

  it("turns a throwing source into a group that carries the error, not a rejection", async () => {
    const sources = [
      source({ key: "ok", load: async () => [item({ key: "x" })] }),
      source({ key: "broken", load: async () => { throw new Error("relation does not exist"); } }),
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const groups = await collectAlerts(admin, { grants: { [ROOT]: "admin" }, sources });
    spy.mockRestore();

    const broken = groups.find((g) => g.key === "broken")!;
    expect(broken.error).toBe("relation does not exist");
    expect(broken.items).toEqual([]);
    expect(groups.find((g) => g.key === "ok")!.items).toHaveLength(1);
  });

  it("hands every source the same brewery date", async () => {
    const seen: string[] = [];
    const sources = [
      source({ key: "a", load: async (_c, ctx) => { seen.push(ctx.today); return []; } }),
      source({ key: "b", load: async (_c, ctx) => { seen.push(ctx.today); return []; } }),
    ];
    await collectAlerts(admin, { grants: { [ROOT]: "admin" }, sources, today: "2026-09-27" });
    expect(seen).toEqual(["2026-09-27", "2026-09-27"]);
  });
});

describe("filterGroupsForGrants", () => {
  it("narrows an admin's full set to what a brewer may open", async () => {
    const sources = [
      source({ key: "exports", requires: CAP.exportRead }),
      source({ key: "users", section: "settings", requires: CAP.usersManage }),
    ];
    const all = await collectAlerts(admin, { grants: { [ROOT]: "admin" }, sources });
    expect(all).toHaveLength(2);
    const mine = filterGroupsForGrants(all, { "production.export": "read" });
    expect(mine.map((g) => g.key)).toEqual(["exports"]);
  });
});

describe("sortItems", () => {
  it("puts danger first, then the oldest date, then undated", () => {
    const sorted = sortItems([
      item({ key: "info-late", when: "2026-09-20" }),
      item({ key: "undated" }),
      item({ key: "danger-new", severity: "danger", when: "2026-09-25" }),
      item({ key: "danger-old", severity: "danger", when: "2026-09-01" }),
      item({ key: "info-early", when: "2026-09-10" }),
    ]);
    expect(sorted.map((i) => i.key)).toEqual(["danger-old", "danger-new", "info-early", "info-late", "undated"]);
  });
});

describe("countItems", () => {
  it("counts across groups and separates the urgent ones", () => {
    const groups = [
      { key: "a", label: "a", section: "production" as const, href: "/", requires: CAP.exportRead, items: [item({ severity: "danger" }), item()] },
      { key: "b", label: "b", section: "finance" as const, href: "/", requires: CAP.taxRead, items: [item()] },
    ];
    expect(countItems(groups)).toEqual({ total: 3, danger: 1 });
  });
});
