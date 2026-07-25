import { describe, it, expect, vi, beforeEach } from "vitest";

const authGetUser = vi.fn();
const fromCalls: string[] = [];

let currentRole = "viewer";
let currentGrantRows: { scope: string; level: string }[] = [];

function makeProfilesChain(role: string) {
  return {
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data: { role }, error: null }),
      }),
    }),
  };
}

function makeGrantsChain(rows: { scope: string; level: string }[]) {
  return {
    select: () => ({
      eq: () => Promise.resolve({ data: rows, error: null }),
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: () => authGetUser() },
    from: (table: string) => {
      fromCalls.push(table);
      if (table === "profiles") return makeProfilesChain(currentRole);
      if (table === "user_permission_grants") return makeGrantsChain(currentGrantRows);
      throw new Error(`unexpected table ${table}`);
    },
  })),
}));

import { getSessionUser } from "./session";
import { ROLE_BUNDLES } from "./roleGrants";
import { can } from "./resolve";
import { CAP } from "./capabilities";

describe("getSessionUser", () => {
  beforeEach(() => {
    fromCalls.length = 0;
    currentRole = "viewer";
    currentGrantRows = [];
    authGetUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.com" } } });
  });

  it("returns null when there is no session", async () => {
    authGetUser.mockResolvedValue({ data: { user: null } });
    expect(await getSessionUser()).toBeNull();
  });

  it("resolves a viewer to ROLE_BUNDLES.viewer without querying user_permission_grants", async () => {
    currentRole = "viewer";
    const session = await getSessionUser();
    expect(session?.role).toBe("viewer");
    expect(session?.grants).toEqual(ROLE_BUNDLES.viewer);
    expect(fromCalls).not.toContain("user_permission_grants");
  });

  it("resolves a custom user to their grant rows", async () => {
    currentRole = "custom";
    currentGrantRows = [{ scope: "tax.pii", level: "admin" }];
    const session = await getSessionUser();
    expect(session?.role).toBe("custom");
    expect(session?.grants).toEqual({ "tax.pii": "admin" });
  });

  it("resolves a custom user with zero rows to {} — can() is false for every capability", async () => {
    currentRole = "custom";
    currentGrantRows = [];
    const session = await getSessionUser();
    expect(session?.grants).toEqual({});
    for (const cap of Object.values(CAP)) {
      expect(can(session!.grants, cap.scope, cap.level)).toBe(false);
    }
  });
});
