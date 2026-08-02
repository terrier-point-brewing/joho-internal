/**
 * In-memory Supabase stand-in covering everything `syncSquareOrders` touches.
 *
 * The invoice half of that function cannot be proved by testing a pure builder:
 * the defect it fixes lived in the relationship between a builder and the writer
 * that stores its rows, and the only way to pin "a hand-set account survives a
 * re-sync" is to run the sync twice against something that remembers. So this
 * keeps real rows, honours `onConflict` on upsert, and lets a test make one
 * table's reads fail so the quarantine path can be exercised.
 *
 * Deliberately literal about the calls the sync actually makes and no more.
 * `.not(...)` and `.or(...)` are accepted and ignored — both are used only to
 * narrow a read whose seeded rows are already the narrowed set — so a test that
 * needs those semantics must seed for them rather than rely on the stub.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

type Predicate = (row: Row) => boolean;

export interface FinanceSyncDb {
  client: SupabaseClient;
  /** Live rows, by table name. Assert against these after a sync. */
  rows: (table: string) => Row[];
  /** Make every `select` on these tables answer with an error. */
  failSelectsOn: (...tables: string[]) => void;
}

export function financeSyncDb(seed: Record<string, Row[]> = {}): FinanceSyncDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const failing = new Set<string>();
  let nextId = 1;

  const table = (name: string): Row[] => (tables[name] ??= []);
  /** Stands in for the server-generated primary key. */
  const withId = (row: Row): Row => ({ id: `id-${nextId++}`, ...row });

  function matcher(filters: Predicate[]) {
    return (row: Row) => filters.every((f) => f(row));
  }

  function chain(name: string, run: (match: (row: Row) => boolean) => { data: unknown; error: unknown }) {
    const filters: Predicate[] = [];
    const self: Record<string, unknown> = {
      eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), self),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), self),
      gt: (col: string, val: number) => (filters.push((r) => (r[col] as number) > val), self),
      // Narrowing this stub does not model — see the note at the top.
      not: () => self,
      or: () => self,
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        if (failing.has(name)) {
          return Promise.resolve({ data: null, error: { message: `select on ${name} failed` } }).then(resolve);
        }
        return Promise.resolve(run(matcher(filters))).then(resolve);
      },
    };
    return self;
  }

  /** Both awaitable (`{ error }`) and `.select()`-able, as the sync uses both. */
  function writeResult(written: Row[]) {
    const answer = () => ({ data: written.map((r) => ({ ...r })), error: null });
    return {
      select: () => Promise.resolve(answer()),
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(answer()).then(resolve),
    };
  }

  const client = {
    from: (name: string) => ({
      select: () => chain(name, (match) => ({ data: table(name).filter(match).map((r) => ({ ...r })), error: null })),

      insert: (rows: Row[]) => {
        const written = rows.map((r) => withId({ ...r }));
        table(name).push(...written);
        return writeResult(written);
      },

      upsert: (rows: Row[], opts?: { onConflict?: string }) => {
        const keys = (opts?.onConflict ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        const written: Row[] = [];
        for (const row of rows) {
          const at = keys.length
            ? table(name).findIndex((s) => keys.every((k) => s[k] === row[k]))
            : -1;
          if (at >= 0) {
            // Keep the server-assigned id, as a real upsert does — the invoice
            // tax rebuild reads it back to key invoice_line_item_taxes.
            table(name)[at] = { ...table(name)[at], ...row };
            written.push(table(name)[at]);
          } else {
            const fresh = withId({ ...row });
            table(name).push(fresh);
            written.push(fresh);
          }
        }
        return writeResult(written);
      },

      delete: () =>
        chain(name, (match) => {
          tables[name] = table(name).filter((r) => !match(r));
          return { data: null, error: null };
        }),
    }),
  } as unknown as SupabaseClient;

  return {
    client,
    rows: (name: string) => table(name).map((r) => ({ ...r })),
    failSelectsOn: (...names: string[]) => names.forEach((n) => failing.add(n)),
  };
}
