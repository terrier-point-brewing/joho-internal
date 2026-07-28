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
  it("fixture has exactly 213 rows, 30 with an intentional change, every reason non-empty", () => {
    expect(LEGACY_MATRIX).toHaveLength(213);

    const changed = LEGACY_MATRIX.filter((row) => row.intentionalChange);
    expect(changed).toHaveLength(30);

    for (const row of changed) {
      expect(row.intentionalChange!.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("every (route, role) pair matches legacy behaviour, except the 30 documented changes", () => {
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
