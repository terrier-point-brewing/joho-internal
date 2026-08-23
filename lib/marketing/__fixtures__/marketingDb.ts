/**
 * An in-memory stand-in for the marketing tables, built to make ONE property
 * testable: that a statement is atomic and the awaits around it are not.
 *
 * That property is the entire reason the worker's claim is a single
 * `update … returning *`. A fake that resolved every query synchronously would
 * make a select-then-update claim look just as safe as the real one, and the
 * concurrency test would prove nothing. So this fake models the two things
 * READ COMMITTED actually gives you:
 *
 *   1. **Between statements, control yields.** Every query awaits a tick before
 *      it touches the tables, so two concurrent callers genuinely interleave at
 *      every await — exactly where a select-then-update claim loses its race.
 *   2. **Within a statement, nothing interleaves.** Once a query starts, it
 *      matches its rows and applies its patch in one synchronous pass. An
 *      `update … where status = 'scheduled'` therefore re-reads and re-filters
 *      against the rows as they stand at that instant, which is the property
 *      the real claim leans on.
 *
 * `worker.test.ts` proves the fake has teeth by running a deliberately wrong
 * select-then-update claim against it and showing that it DOES double-publish.
 * Without that companion test this file would be an assumption, not a fixture.
 *
 * It is not a Postgres. There are no triggers (so nothing derives an entry's
 * status here), no RLS, and no type coercion. It supports precisely the query
 * shapes lib/marketing uses, and a query shape it does not know is a thrown
 * error rather than a silently empty result.
 */

export type Row = Record<string, unknown>;

export interface MarketingTables {
  marketing_deliveries: Row[];
  marketing_calendar_entries: Row[];
  marketing_entry_media: Row[];
  marketing_media: Row[];
  marketing_connected_accounts: Row[];
  [table: string]: Row[];
}

type Op = "select" | "update";

interface Db {
  tables: MarketingTables;
  tick: () => Promise<void>;
  /** Every statement executed, in order. Useful for asserting a claim was one statement. */
  statements: string[];
}

class Query implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private filters: Array<(r: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitTo: number | null = null;
  private returning = false;
  private columns = "*";
  private started: Promise<{ data: Row[] | null; error: { message: string } | null }> | null = null;

  constructor(
    private db: Db,
    private table: string,
    private op: Op,
    private patch: Row | null,
  ) {}

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  /** Null is never `<=` anything, matching SQL's three-valued logic closely enough to matter. */
  lte(col: string, val: unknown): this {
    this.filters.push((r) => {
      const v = r[col];
      return v !== null && v !== undefined && (v as string) <= (val as string);
    });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.limitTo = n;
    return this;
  }

  select(columns = "*"): this {
    this.returning = true;
    this.columns = columns;
    return this;
  }

  then<A, B = never>(
    onOk?: ((v: { data: Row[] | null; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    onErr?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // Memoised: awaiting the same builder twice must not run the statement twice.
    this.started ??= this.run();
    return this.started.then(onOk, onErr);
  }

  private async run(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
    // The ONLY await. Everything past this line is one atomic statement.
    await this.db.tick();

    const table = this.db.tables[this.table];
    if (!table) throw new Error(`marketingDb: no table "${this.table}"`);
    this.db.statements.push(`${this.op} ${this.table}`);

    let rows = table.filter((r) => this.filters.every((f) => f(r)));

    if (this.op === "update") {
      for (const r of rows) Object.assign(r, this.patch);
      // A snapshot, so a later mutation cannot retroactively change what this
      // statement returned.
      return { data: this.returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }

    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => {
        const x = a[col] as number;
        const y = b[col] as number;
        return asc ? x - y : y - x;
      });
    }
    if (this.limitTo !== null) rows = rows.slice(0, this.limitTo);

    // The one embed the worker uses: entry media joined to the media itself.
    if (this.columns.includes("media:marketing_media(")) {
      return {
        data: rows.map((r) => ({
          position: r.position,
          media: this.db.tables.marketing_media.find((m) => m.id === r.media_id) ?? null,
        })),
        error: null,
      };
    }

    return { data: rows.map((r) => ({ ...r })), error: null };
  }
}

export interface MarketingTestDb {
  /** Cast to SupabaseClient at the call site; it implements only what lib/marketing calls. */
  client: {
    from(table: string): {
      select(columns?: string): Query;
      update(patch: Row): Query;
    };
  };
  tables: MarketingTables;
  statements: string[];
}

/**
 * @param seed the rows each table starts with; tables are mutated in place, so
 *   the caller can assert against `tables` after a run.
 * @param tick what a statement awaits before executing. The default yields a
 *   macrotask, which is what forces two concurrent callers to interleave.
 */
export function createMarketingTestDb(
  seed: Partial<MarketingTables> = {},
  tick: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): MarketingTestDb {
  const tables: MarketingTables = {
    marketing_deliveries: seed.marketing_deliveries ?? [],
    marketing_calendar_entries: seed.marketing_calendar_entries ?? [],
    marketing_entry_media: seed.marketing_entry_media ?? [],
    marketing_media: seed.marketing_media ?? [],
    marketing_connected_accounts: seed.marketing_connected_accounts ?? [],
  };
  const statements: string[] = [];
  const db: Db = { tables, tick, statements };

  return {
    tables,
    statements,
    client: {
      from(table: string) {
        return {
          select: (columns = "*") => new Query(db, table, "select", null).select(columns),
          update: (patch: Row) => new Query(db, table, "update", patch),
        };
      },
    },
  };
}

// ── Seed helpers ────────────────────────────────────────────────────────────
// Deliberately plain: a test that needs an entry to be unusual says so at the
// call site rather than reaching for an option here.

export const TEST_ACCOUNT_ID = "acc-1";

export function testAccount(channel: string, id = TEST_ACCOUNT_ID): Row {
  return {
    id,
    provider: "fake",
    channel,
    external_id: "ext-1",
    external_parent_id: null,
    handle: "@fakebrewing",
    // A secret, present so a test can prove it never reaches a log or an error.
    credentials: { accessToken: "super-secret-token" },
    token_expires_at: null,
    scopes: ["fake.publish"],
  };
}

export function testEntry(id: string, over: Row = {}): Row {
  return {
    id,
    kind: "post",
    starts_at: "2026-08-22T09:00:00.000Z",
    ends_at: null,
    caption: "A beer that tastes like a Tuesday.",
    details: {},
    status: "scheduled",
    origin: "manual",
    tags: [],
    ...over,
  };
}

export function testDelivery(id: string, entryId: string, channel: string, over: Row = {}): Row {
  return {
    id,
    entry_id: entryId,
    account_id: TEST_ACCOUNT_ID,
    channel,
    scheduled_at: "2020-01-01T00:00:00.000Z",
    status: "scheduled",
    external_ids: {},
    error: null,
    attempt_count: 0,
    published_at: null,
    ...over,
  };
}
