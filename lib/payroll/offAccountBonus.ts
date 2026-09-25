/**
 * The taproom check's blind spot, shared by the period detail panel
 * (GustoUploadPanel) and the periods table (periodSummary).
 *
 * The Gusto side of the check sums wages mapped to the taproom account plus
 * paycheck tips. A bartender-table employee whose Gusto department maps
 * elsewhere (a salaried manager who also pulls shifts) has their Bonus folded
 * into that other account's wages, where the taproom filter can't see it. The
 * app still expects it, so it's added back here. Taproom-mapped departments
 * are skipped — their bonus is already inside the taproom wage bucket.
 */

export interface OffAccountBonusEmployee {
  first_name: string;
  last_name: string;
  department: string;
  bonus_cents: number | null;
}

export const staffNameKey = (first: string, last: string) => `${first.trim()} ${last.trim()}`.toLowerCase();

export function computeOffAccountBonusCents(
  employees: OffAccountBonusEmployee[],
  appStaffKeys: Set<string>,
  departmentAccounts: Map<string, string>,
  taproomAccountId: string | null,
): number {
  if (!taproomAccountId) return 0;
  return employees
    .filter(
      (e) =>
        appStaffKeys.has(staffNameKey(e.first_name, e.last_name)) &&
        departmentAccounts.get(e.department.trim()) !== taproomAccountId,
    )
    .reduce((s, e) => s + (e.bonus_cents ?? 0), 0);
}
