import { describe, it, expect } from "vitest";
import { parseControlsState, serializeControlsState, countActiveControls } from "./urlState";
import type { ControlsConfig, ControlsState } from "./types";

interface Row { recipe: string; status: string; volume: number }

const CONFIG: ControlsConfig<Row> = {
  search: [{ param: "q", accessor: (r) => r.recipe }],
  filters: [
    { param: "status", accessor: (r) => r.status },
    { param: "channel", accessor: (r) => r.status, multi: true },
  ],
  sort: {
    columns: [{ key: "volume", accessor: (r) => r.volume }],
    default: { key: "volume", dir: "desc" },
  },
};

describe("parseControlsState", () => {
  it("reads search, filters (comma-split), and sort from params", () => {
    const p = new URLSearchParams("q=hazy&status=open&channel=a,b&sort=-volume");
    const s = parseControlsState(p, CONFIG);
    expect(s.search).toEqual({ q: "hazy" });
    expect(s.filters).toEqual({ status: ["open"], channel: ["a", "b"] });
    expect(s.sort).toEqual({ key: "volume", dir: "desc" });
  });

  it("ascending sort has no leading dash", () => {
    const s = parseControlsState(new URLSearchParams("sort=volume"), CONFIG);
    expect(s.sort).toEqual({ key: "volume", dir: "asc" });
  });

  it("falls back to the default sort when the param is absent", () => {
    const s = parseControlsState(new URLSearchParams(""), CONFIG);
    expect(s.sort).toEqual({ key: "volume", dir: "desc" });
    expect(s.search).toEqual({});
    expect(s.filters).toEqual({});
  });

  it("honors a namespace prefix", () => {
    const s = parseControlsState(new URLSearchParams("t1_q=x&t1_status=open"), CONFIG, "t1_");
    expect(s.search).toEqual({ q: "x" });
    expect(s.filters).toEqual({ status: ["open"] });
  });
});

describe("serializeControlsState", () => {
  it("writes only non-empty controls and preserves unrelated params", () => {
    const state: ControlsState = {
      search: { q: "hazy" },
      filters: { status: ["open"], channel: [] },
      sort: { key: "volume", dir: "asc" },
    };
    const base = new URLSearchParams("tab=export");
    const out = serializeControlsState(state, CONFIG, base);
    expect(out.get("tab")).toBe("export");
    expect(out.get("q")).toBe("hazy");
    expect(out.get("status")).toBe("open");
    expect(out.has("channel")).toBe(false);
    expect(out.get("sort")).toBe("volume");
  });

  it("clears a param that became empty", () => {
    const base = new URLSearchParams("q=old&status=open");
    const state: ControlsState = { search: { q: "" }, filters: { status: [] }, sort: null };
    const out = serializeControlsState(state, CONFIG, base);
    expect(out.has("q")).toBe(false);
    expect(out.has("status")).toBe(false);
    expect(out.has("sort")).toBe(false);
  });

  it("round-trips through parse", () => {
    const state: ControlsState = {
      search: { q: "stout" },
      filters: { status: ["closed"], channel: ["a", "b"] },
      sort: { key: "volume", dir: "desc" },
    };
    const sp = serializeControlsState(state, CONFIG, new URLSearchParams());
    expect(parseControlsState(sp, CONFIG)).toEqual(state);
  });
});

describe("countActiveControls", () => {
  it("counts non-empty searches and filter dimensions, ignoring sort", () => {
    expect(countActiveControls({ search: { q: "x" }, filters: { status: ["open"], channel: [] }, sort: { key: "volume", dir: "asc" } })).toBe(2);
    expect(countActiveControls({ search: { q: "" }, filters: {}, sort: null })).toBe(0);
  });
});
