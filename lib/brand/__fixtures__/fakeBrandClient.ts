/**
 * A minimal fake Supabase-like client shared by the Phase B module tests.
 *
 * Covers the query shapes lib/brand's modules use: from().select().eq()…
 * limit()/order() for reads, from().insert().select().single() for the returned
 * row, and from().update().eq() for status flips.
 *
 * `uniqueWhere` reproduces a partial unique index in memory. That is the point
 * of this fixture rather than a looser stub: three modules depend on
 * archive-before-write ordering (publishTemplate, activateSeason, approveAsset),
 * and the ONLY thing that makes the wrong order fail is the index. A fake
 * without it passes both orderings and tests nothing.
 */
export interface FakeRow {
  id: string;
  [key: string]: unknown;
}

export function fakeBrandClient<T extends FakeRow>(
  initialRows: T[],
  options: {
    /** e.g. { column: "status", value: "published", scopeBy: "key" } */
    uniqueWhere?: { column: string; value: string; scopeBy?: string };
  } = {},
) {
  const rows: T[] = initialRows.map((r) => ({ ...r }));
  let idCounter = rows.length;

  function violatesUnique(candidate: Record<string, unknown>, excludeId?: string): boolean {
    const u = options.uniqueWhere;
    if (!u || candidate[u.column] !== u.value) return false;
    return rows.some(
      (r) =>
        r.id !== excludeId &&
        r[u.column] === u.value &&
        (!u.scopeBy || r[u.scopeBy] === candidate[u.scopeBy]),
    );
  }

  function applyFilters(filters: [string, unknown][]) {
    return rows.filter((r) => filters.every(([col, val]) => r[col] === val));
  }

  function chain(filters: [string, unknown][]) {
    return {
      eq(column: string, value: unknown) {
        return chain([...filters, [column, value]]);
      },
      order(column: string, opts?: { ascending?: boolean }) {
        const asc = opts?.ascending ?? true;
        const sorted = [...applyFilters(filters)].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return asc ? (av < bv ? -1 : 1) : av < bv ? 1 : -1;
        });
        return Promise.resolve({ data: sorted, error: null });
      },
      limit(n: number) {
        return Promise.resolve({ data: applyFilters(filters).slice(0, n), error: null });
      },
    };
  }

  return {
    rows,
    from() {
      return {
        select(_cols: string) {
          return chain([]);
        },
        insert(row: Record<string, unknown>) {
          return {
            select() {
              return {
                single() {
                  if (violatesUnique(row)) {
                    return Promise.resolve({ data: null, error: { message: "unique violation" } });
                  }
                  const newRow = { id: `id-${idCounter++}`, ...row } as unknown as T;
                  rows.push(newRow);
                  return Promise.resolve({ data: newRow, error: null });
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              const target = rows.find((r) => r[column] === value);
              if (!target) return Promise.resolve({ error: null });
              if (violatesUnique({ ...target, ...patch }, target.id)) {
                return Promise.resolve({ error: { message: "unique violation" } });
              }
              Object.assign(target, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}
