// Shapes returned by GET /api/finance/balance-sources, shared between the
// screen and its setup panel.
//
// Mirrors the route's response rather than the database: `setup` is resolved
// server-side by lib/finance/balances/methods/setup.ts so the screen never
// re-derives what "configured" means. That derivation existing in two places is
// how the header came to say "12 of 48 accounts have an active source" while
// two of the twelve could not produce a number.

export type MethodKind = "manual" | "postings" | "calculation";

export interface StepMeta {
  key: string;
  label: string;
  description: string;
  source: string;
  direction: "add" | "subtract" | "net";
}

/** One thing a method needs before it can compute, as declared. */
export interface SetupFieldMeta {
  kind: "connection" | "operatorBalance" | "select" | "account" | "user" | "number" | "text" | "date";
  key: string;
  label: string;
  help: string;
  optional?: boolean;
  provider?: "ramp" | "plaid" | "square";
  connect?: "discover" | "authorize";
  options?: { value: string; label: string }[];
  /**
   * Account fields: which statement sections may be picked from. The options
   * themselves are not sent — the screen already holds every balance-sheet
   * account, so sending them again per field would be the same list repeated
   * once per method.
   */
  sections?: string[];
  unit?: string;
}

/** The same field, resolved against one account's stored answers. */
export interface SetupFieldState extends SetupFieldMeta {
  required: boolean;
  satisfied: boolean;
  value: string | null;
  blocker: string | null;
}

export interface SetupState {
  ready: boolean;
  fields: SetupFieldState[];
  outstanding: string | null;
}

export interface MethodMeta {
  key: string;
  label: string;
  kind: MethodKind;
  summary: string;
  connectionProvider: "ramp" | "plaid" | "square" | null;
  setup: SetupFieldMeta[];
  steps: StepMeta[];
}

/** Whether the app can talk to a service at all, and what it can be asked to do. */
export interface ProviderCapability {
  configured: boolean;
  reason?: string;
  canDiscover: boolean;
  canAuthorize: boolean;
  canCheck: boolean;
}

export interface ConnectionMeta {
  connected: boolean;
  label: string;
  lastSyncedAt?: string | null;
  remedy?: string;
}

export interface SourceEntry {
  methodKey: string;
  config: Record<string, unknown>;
  active: boolean;
  updatedAt: string;
  connection: ConnectionMeta | null;
  /** Null only for a legacy bare provider key, which has no declaration to resolve. */
  setup: SetupState | null;
}

export interface BalanceFigure {
  cents: number;
  contributions: Record<string, number>;
}

/**
 * One month end on an account whose balance is DERIVED rather than reported.
 *
 * The swept figures are null when the bank account the money is transferred to
 * had no imported transactions for the period. Null and zero mean different
 * things here and must render differently: zero is "the bank was checked and no
 * transfers were found", null is "there was nothing to check".
 */
export interface ReconciliationRow {
  periodEnd: string;
  driftCents: number;
  sweptExactCents: number | null;
  sweptNameOnlyCents: number | null;
  sweptMatchCount: number | null;
  unexplainedCents: number | null;
}

export interface AccountRow {
  id: string;
  accountName: string;
  accountNumber: string | null;
  statementSection: string | null;
  sources: SourceEntry[];
  availableMethodKeys: string[];
  /** The last month that has CLOSED. Null until one has been snapshotted. */
  currentBalance: (BalanceFigure & { periodEnd: string }) | null;
  /** Where the account stands today, in the month still in progress. */
  liveBalance: BalanceFigure | null;
  /** Set when this account's calculation threw while computing just now. */
  liveError: string | null;
  /** Month-end checks, newest first. Empty for a reported (non-derived) balance. */
  reconciliations: ReconciliationRow[];
}

/**
 * Someone who can be named responsible for an account, for `user` setup fields.
 *
 * Sent with the catalog for the same reason connections are: the picker needs
 * them on first paint. Id and sign-in address only — this is a "who", not a
 * profile, and nothing here needs to know anything else about them.
 */
export interface UserRef {
  id: string;
  email: string;
}

export interface BalanceSourcesResponse {
  accounts: AccountRow[];
  methods: MethodMeta[];
  providers: Record<string, ProviderCapability>;
  users: UserRef[];
}

/**
 * What survives a full-page redirect to an OAuth bank and back.
 *
 * Carries the account and method as well as the token, because the panel this
 * was opened from is gone by the time the bank returns and has to be reopened
 * against the right row.
 */
export interface PlaidResumeState {
  token: string;
  connectionId?: string;
  label: string;
  coaId: string;
  methodKey: string;
}

export const PLAID_RESUME_KEY = "balance-setup-authorize-resume";
