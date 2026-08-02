/**
 * Is this account's chosen method actually ready to compute, and if not, what
 * is still missing?
 *
 * ── Why this is a pure function ──────────────────────────────────────────────
 * The same question gets asked in three places -- the Settings row's status
 * line, the setup panel's per-field state, and the "is this account really
 * configured" count in the page header. Answering it three times is how a
 * screen ends up saying "12 of 48 accounts have an active source" while two of
 * those twelve cannot produce a number. Everything IO-shaped is resolved by the
 * caller and handed in as facts; the decision lives here and is tested directly.
 *
 * ── "Configured" means every required field is answered ──────────────────────
 * Not "a row exists in balance_sheet_account_sources". A source row is a
 * DECLARATION of intent; readiness is whether that intent can be carried out.
 * GL 1020 is the standing example: an active source naming the Plaid method,
 * pointing at no connection, on an app with no Plaid credentials. Three
 * different reasons it produces nothing, none of them visible from the row.
 */
import { formatEnteredAmountCents } from "../../manualEntryAmount";
import type { BalanceMethod, ConnectionProvider, SetupField } from "./registry";

/** A connection as the setup panel needs to see it. No secrets, by construction. */
export interface SetupConnectionRef {
  id: string;
  provider: ConnectionProvider;
  label: string;
  status: string;
}

/** Whether the APP can talk to a service at all, before any account links one. */
export interface ProviderReadiness {
  configured: boolean;
  /** Populated when configured is false: what a person must do about it. */
  reason?: string;
}

/** Everything outside the method declaration that readiness depends on. */
export interface SetupFacts {
  /** The source's stored config -- where every field except operatorBalance keeps its answer. */
  config: Record<string, unknown>;
  /** Connections that exist, keyed by id. */
  connectionsById: Map<string, SetupConnectionRef>;
  /** The account's most recent operator-entered balance, if any. */
  operatorBalance: { asOfDate: string; cents: number } | null;
  /** Per-service app-level configuration state. A provider absent from the map is treated as unconfigured. */
  providerReadiness: Map<ConnectionProvider, ProviderReadiness>;
  /**
   * Display labels for chart-of-accounts rows, for `account` fields. An id
   * missing from this map means the account was deleted, which the field
   * surfaces rather than rendering a bare uuid at someone.
   */
  accountLabels?: Map<string, string>;
  /**
   * Display labels for people, for `user` fields. Same contract as
   * accountLabels: an id missing from the map means that person's account is
   * gone, which the field says out loud rather than leaving an account looking
   * configured while its alerts go nowhere.
   */
  userLabels?: Map<string, string>;
}

export interface SetupFieldState {
  key: string;
  kind: SetupField["kind"];
  label: string;
  help: string;
  required: boolean;
  satisfied: boolean;
  /** The stored answer, as a string the UI can render. Null when unanswered. */
  value: string | null;
  /**
   * Why this field is not satisfied, in plain English. Null when it is.
   *
   * Distinct from `help`, deliberately: help says what the field is FOR and
   * never changes; this says what is wrong RIGHT NOW. A screen that only has
   * the former makes an operator guess whether they already did the thing.
   */
  blocker: string | null;
  /** Connection fields only — lets the UI render a picker without re-deriving it. */
  provider?: ConnectionProvider;
  connect?: "discover" | "authorize";
  /** Select fields only. */
  options?: { value: string; label: string }[];
  /** Account fields only — which statement sections may be picked from. */
  sections?: string[];
  /** Number fields only. */
  unit?: string;
}

export interface SetupState {
  /** True when every REQUIRED field is answered. An optional gap never blocks. */
  ready: boolean;
  fields: SetupFieldState[];
  /**
   * One sentence naming what is outstanding, or null when ready. Written for
   * the row's status line, where there is space for a sentence and not a list.
   */
  outstanding: string | null;
}

/** A method with nothing to set up is ready the moment it is selected. */
const READY: SetupState = { ready: true, fields: [], outstanding: null };

function connectionState(
  field: SetupField & { kind: "connection" },
  facts: SetupFacts,
): { satisfied: boolean; value: string | null; blocker: string | null } {
  // App-level configuration is checked FIRST, because "you have not linked an
  // account" is misleading advice when there is no way to link one yet. This is
  // the exact dead end GL 1020 sat in: a picker offering nothing, telling the
  // operator to set one up first, on an app that could not have.
  const readiness = facts.providerReadiness.get(field.provider);
  if (!readiness?.configured) {
    return {
      satisfied: false,
      value: null,
      blocker: readiness?.reason ?? `${field.provider} has not been set up for this app yet.`,
    };
  }

  const id = facts.config[field.key];
  if (typeof id !== "string" || id.length === 0) {
    return { satisfied: false, value: null, blocker: "No account is linked yet." };
  }

  const connection = facts.connectionsById.get(id);
  // A dangling id: the connection was removed but the source still names it.
  // resolveConnection returns null for this and the account reads as unsourced,
  // so saying so here is the only place it becomes visible.
  if (!connection) {
    return { satisfied: false, value: null, blocker: "The linked account no longer exists. Link one again." };
  }
  if (connection.status !== "active") {
    return {
      satisfied: false,
      value: connection.label,
      blocker:
        connection.status === "needs_reauth"
          ? "The connection expired. Reconnect it to resume automatic balances."
          : connection.status === "disabled"
            ? "This connection is turned off."
            : "The last read from this connection failed.",
    };
  }
  return { satisfied: true, value: connection.label, blocker: null };
}

function fieldState(field: SetupField, facts: SetupFacts): SetupFieldState {
  const base = {
    key: field.key,
    kind: field.kind,
    label: field.label,
    help: field.help,
    required: !field.optional,
  };

  if (field.kind === "connection") {
    return { ...base, ...connectionState(field, facts), provider: field.provider, connect: field.connect };
  }

  if (field.kind === "operatorBalance") {
    // Any date satisfies it, not just this month's. The figure is a starting
    // point that carries forward until it is superseded, so an account with
    // last month's balance is configured and computing -- it is the month-end
    // close, not this check, that asks for a fresher one.
    const entered = facts.operatorBalance;
    return {
      ...base,
      satisfied: entered !== null,
      // Rendered through the entered-amount formatter, not the shared money
      // one: a confirmed zero has to look different from an account nobody has
      // answered, and this line sits directly above a blocker that says exactly
      // that. `entered &&` would be the same trap one level up -- a zero-cents
      // reading is a reading.
      value: entered ? `${formatEnteredAmountCents(entered.cents)} as at ${entered.asOfDate}` : null,
      blocker: entered ? null : "No balance has been entered yet.",
    };
  }

  const raw = facts.config[field.key];
  const answered = raw !== undefined && raw !== null && raw !== "";
  const state = {
    ...base,
    satisfied: answered,
    value: answered ? String(raw) : null,
    blocker: answered ? null : "Not set yet.",
  };
  if (field.kind === "select") return { ...state, options: field.options };
  if (field.kind === "number") return { ...state, unit: field.unit ?? "plain" };

  // A named person whose login has since been removed. Identical treatment to
  // a deleted account below, and it matters more: the field would otherwise
  // read as satisfied while every alert for this account went to a user who
  // cannot act on it.
  if (field.kind === "user") {
    if (!answered) return { ...state, blocker: "Nobody has been named yet." };
    const label = facts.userLabels?.get(String(raw));
    return label
      ? { ...state, value: label }
      : {
          ...state,
          satisfied: false,
          value: null,
          blocker: "The person named here no longer has an account. Choose someone else.",
        };
  }

  if (field.kind === "account") {
    if (!answered) return { ...state, sections: field.sections };
    // A stored id whose account has since been deleted. Rendering the raw uuid
    // would be the code-identifier-at-a-bookkeeper failure this layer exists to
    // avoid, and silently showing "set" would hide a broken reference.
    const label = facts.accountLabels?.get(String(raw));
    return label
      ? { ...state, value: label, sections: field.sections }
      : {
          ...state,
          satisfied: false,
          value: null,
          blocker: "The account this pointed at no longer exists. Choose another.",
          sections: field.sections,
        };
  }

  return state;
}

/**
 * Resolves a method's setup against one account's stored answers.
 *
 * `outstanding` names the first unmet REQUIRED field rather than listing every
 * one. A row has space for a sentence, and the first thing to do is the only
 * thing an operator can act on anyway -- the panel shows the rest.
 */
export function resolveSetupState(method: BalanceMethod, facts: SetupFacts): SetupState {
  if (!method.setup || method.setup.length === 0) return READY;

  const fields = method.setup.map((field) => fieldState(field, facts));
  const blocking = fields.filter((f) => f.required && !f.satisfied);

  return {
    ready: blocking.length === 0,
    fields,
    outstanding:
      blocking.length === 0
        ? null
        : blocking.length === 1
          ? `${blocking[0].label}: ${blocking[0].blocker}`
          : `${blocking[0].label}: ${blocking[0].blocker} (${blocking.length - 1} more to finish)`,
  };
}
