import { describe, it, expect } from "vitest";
import { can } from "../resolve";
import { CAP } from "../capabilities";
import { ROLE_BUNDLES, type UserRole } from "../roleGrants";
import { LEGACY_MATRIX } from "../__fixtures__/legacy-matrix";

const ROLES: UserRole[] = ["viewer", "brewer", "manager", "admin"];

/** Exact semantics of the retired lib/auth requireRole helper. */
function legacyRequireRole(role: UserRole, list: UserRole[]): boolean {
  return role === "admin" || list.includes(role);
}

describe("legacy role <-> scoped permission equivalence", () => {
  // 53 = 30 inherited (the original legacy-role -> scoped-permission migration,
  // plus the tips-passthrough route row from #284), and 23 from the 2026-07-28
  // scope restructure: 19 tax routes manager no longer reaches (their tax grant
  // was unreachable and was removed), 4 Square-mapping routes that moved to the
  // shared `catalog` scope, and the excise-rates row, which already carried a
  // change and gained `manager: false`.
  //
  // This count is the whole point of the fixture: a bundle edit that moves any
  // (route, role) answer WITHOUT a recorded reason fails here rather than
  // shipping as silent drift.
  it("fixture has exactly 213 rows, 53 with an intentional change, every reason non-empty", () => {
    expect(LEGACY_MATRIX).toHaveLength(213);

    const changed = LEGACY_MATRIX.filter((row) => row.intentionalChange);
    expect(changed).toHaveLength(53);

    for (const row of changed) {
      expect(row.intentionalChange!.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("every (route, role) pair matches legacy behaviour, except the 53 documented changes", () => {
    let assertions = 0;

    for (const row of LEGACY_MATRIX) {
      for (const role of ROLES) {
        const cap = CAP[row.capability];
        const expected = row.intentionalChange?.[role] ?? legacyRequireRole(role, row.legacy);

        expect(
          can(ROLE_BUNDLES[role], cap.scope, cap.level),
          `${row.method} ${row.route} / ${role}`
        ).toBe(expected);

        assertions++;
      }
    }

    expect(assertions).toBe(852);
  });
});
