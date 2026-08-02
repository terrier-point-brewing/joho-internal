"use client";
// The setup panel: whatever a method says it still needs, asked for in one
// place, in the order it can actually be done.
//
// ── Why this is generic ──────────────────────────────────────────────────────
// Ramp, Plaid and Square each shipped their own Settings screen. Configuring an
// account meant visiting two screens in the wrong order -- the connection had
// to exist before the app had told you it was needed -- and the picker on this
// screen dead-ended with "set one up first" and no link to anywhere.
//
// This panel renders whatever `method.setup` declares. It knows about FIELD
// KINDS, never about Ramp or Plaid or Square, so a new calculation with new
// prerequisites -- a useful life, an in-service date, a rate -- appears here
// the moment it is declared, with no code in this file.
//
// ── Dollar values still are not stored here ──────────────────────────────────
// An `operatorBalance` field writes a manual_entries balance row through
// /api/finance/balance-sources/operator-balance, which is the same row Finance
// > Transactions > Manual Entries writes and the same one the month-end close
// chases. This panel is a shortcut to it in the context that explains what it
// is for, not a second store.

import { useState, useEffect, useCallback, useRef } from "react";
import { formatAmountInput, parseAmountInputCents } from "@/lib/finance/manualEntryAmount";
import { monthEnd } from "@/lib/finance/manualEntries";
import { formatCurrencyCents } from "@/lib/format";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import { Modal } from "@/app/components/ui/Modal";
import type { AccountRow, MethodMeta, ProviderCapability, SetupFieldState, SourceEntry, UserRef } from "./types";
import { PLAID_RESUME_KEY, type PlaidResumeState } from "./types";

const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface Candidate {
  externalId: string;
  label: string;
  sublabel?: string | null;
  connectionId?: string | null;
}

interface PlaidHandler {
  open: () => void;
  exit: () => void;
  destroy: () => void;
}

interface PlaidLinkGlobal {
  create(config: {
    token: string;
    receivedRedirectUri?: string;
    onSuccess: (publicToken: string) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }): PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLinkGlobal;
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

/** Loads Plaid's Link script once, resolving when window.Plaid is available. */
function loadPlaidScript(): Promise<PlaidLinkGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SRC}"]`);
    const script = existing ?? document.createElement("script");

    const done = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid Link failed to load.")));
    script.addEventListener("load", done, { once: true });
    script.addEventListener("error", () => reject(new Error("Plaid Link could not be reached.")), { once: true });

    if (!existing) {
      script.src = PLAID_LINK_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Plaid) {
      done();
    }
  });
}

/** Writes the operator's choice of external account onto the source's config. */
async function linkConnection(coaId: string, methodKey: string, config: Record<string, unknown>, patch: Record<string, unknown>) {
  const res = await fetch("/api/finance/balance-sources", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // Merge rather than replace: the route stores config wholesale, so dropping
    // the rest of it here would quietly discard other setup answers.
    body: JSON.stringify({ coaId, providerKey: methodKey, config: { ...config, ...patch } }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not save that.");
}

// ── Field controls ───────────────────────────────────────────────────────────

function FieldShell({
  field,
  children,
}: {
  field: SetupFieldState;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-body">{field.label}</span>
        <Badge tone={field.satisfied ? "success" : field.required ? "danger" : "neutral"}>
          {field.satisfied ? "Done" : field.required ? "Needed" : "Optional"}
        </Badge>
      </div>
      <p className="text-2xs text-faint leading-relaxed">{field.help}</p>
      {/* What is wrong right now, as opposed to what the field is for. Without
          it an operator cannot tell whether they already did the thing.

          Only a REQUIRED gap is coloured as a problem. An unanswered optional
          field is a note, and putting it in danger red makes a ready account
          look broken. */}
      {!field.satisfied && field.blocker && (
        <p className={`text-2xs ${field.required ? "text-danger" : "text-muted"}`}>{field.blocker}</p>
      )}
      {field.satisfied && field.value && <p className="text-2xs text-muted">Currently: {field.value}</p>}
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/**
 * A connection field.
 *
 * Both flows end identically -- a chosen external account written to the
 * connection's external_id and the connection's id written to the source's
 * config -- so only the way candidates are OBTAINED differs.
 */
function ConnectionField({
  field,
  account,
  source,
  capability,
  onDone,
  onError,
}: {
  field: SetupFieldState;
  account: AccountRow;
  source: SourceEntry;
  capability: ProviderCapability | undefined;
  onDone: () => void | Promise<unknown>;
  onError: (message: string) => void;
}) {
  const provider = field.provider!;
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const handlerRef = useRef<PlaidHandler | null>(null);

  useEffect(() => () => handlerRef.current?.destroy(), []);

  // An unconfigured service is a wall, not a form. Saying so plainly is the
  // whole point -- the previous screen offered a "Connect a bank" button that
  // threw a raw missing-environment-variable error when pressed.
  //
  // Decided here but RENDERED at the bottom: the OAuth resume effect below must
  // run on every render regardless, or a bank redirect landing while this field
  // happens to read as unconfigured would silently drop the sign-in.
  const blocked = capability && !capability.configured;

  async function choose(candidate: Candidate) {
    setBusy(true);
    try {
      // Reuse the existing connection row when one already points at this
      // external account; creating a second would trip the (provider,
      // external_id) unique index with a raw database error.
      const saved = await putJson<{ id: string }>("/api/finance/balance-connections", {
        id: candidate.connectionId ?? undefined,
        provider,
        label: candidate.label,
        externalId: candidate.externalId,
      });

      await linkConnection(account.id, source.methodKey, source.config, { [field.key]: saved.id });
      setCandidates(null);
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not link that account.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCandidates() {
    setBusy(true);
    try {
      const { candidates: list } = await getJson<{ candidates: Candidate[] }>(
        `/api/finance/balance-connections/${provider}/candidates`,
      );
      setCandidates(list);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not list accounts.");
    } finally {
      setBusy(false);
    }
  }

  const openPlaidLink = useCallback(
    async (resume: PlaidResumeState, receivedRedirectUri?: string) => {
      const Plaid = await loadPlaidScript();
      handlerRef.current?.destroy();
      handlerRef.current = Plaid.create({
        token: resume.token,
        ...(receivedRedirectUri ? { receivedRedirectUri } : {}),
        onSuccess: (publicToken) => {
          sessionStorage.removeItem(PLAID_RESUME_KEY);
          void (async () => {
            setBusy(true);
            try {
              const result = await postJson<{ connectionId: string; candidates: Candidate[] }>(
                `/api/finance/balance-connections/${provider}/complete`,
                { payload: publicToken, connectionId: resume.connectionId, label: resume.label },
              );
              if (result.candidates.length === 0) {
                onError("That bank link has no deposit accounts on it. Balance-sheet cash must come from a bank account.");
                return;
              }
              // The connection exists now, so every candidate belongs to it --
              // choosing one updates that row rather than creating another.
              setCandidates(result.candidates.map((c) => ({ ...c, connectionId: result.connectionId })));
            } catch (err) {
              onError(err instanceof Error ? err.message : "Could not finish connecting that bank.");
            } finally {
              setBusy(false);
            }
          })();
        },
        onExit: (err) => {
          sessionStorage.removeItem(PLAID_RESUME_KEY);
          setBusy(false);
          if (err) onError(err.display_message ?? err.error_message ?? "The bank connection was not completed.");
        },
      });
      handlerRef.current.open();
    },
    [provider, onError],
  );

  /**
   * Resumes a sign-in the bank redirected back from.
   *
   * An OAuth institution -- Chase is one -- navigates the whole page away, so
   * the React state that opened Link is gone by the time the operator returns.
   * The token is stashed before Link opens and picked up here. Without this a
   * Chase link cannot complete at all.
   */
  useEffect(() => {
    if (field.connect !== "authorize") return;
    if (!new URLSearchParams(window.location.search).has("oauth_state_id")) return;
    const stored = sessionStorage.getItem(PLAID_RESUME_KEY);
    if (!stored) return;

    const resume = JSON.parse(stored) as PlaidResumeState;
    if (resume.coaId !== account.id || resume.methodKey !== source.methodKey) return;

    void openPlaidLink(resume, window.location.href).catch(() => {
      sessionStorage.removeItem(PLAID_RESUME_KEY);
      onError("That bank sign-in could not be resumed. Start the connection again.");
    });
    // Mount-only: re-running would open a second Link over the first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startAuthorize() {
    setBusy(true);
    try {
      const existingId = typeof source.config[field.key] === "string" ? (source.config[field.key] as string) : undefined;
      const { token } = await postJson<{ token: string }>(
        `/api/finance/balance-connections/${provider}/authorize`,
        { connectionId: existingId },
      );
      const resume: PlaidResumeState = {
        token,
        connectionId: existingId,
        label: account.accountName,
        coaId: account.id,
        methodKey: source.methodKey,
      };
      // Written BEFORE opening, because an OAuth bank navigates this page away.
      sessionStorage.setItem(PLAID_RESUME_KEY, JSON.stringify(resume));
      await openPlaidLink(resume);
    } catch (err) {
      sessionStorage.removeItem(PLAID_RESUME_KEY);
      setBusy(false);
      onError(err instanceof Error ? err.message : "Could not start that connection.");
    }
  }

  async function runCheck() {
    const id = source.config[field.key];
    if (typeof id !== "string") return;
    setBusy(true);
    setCheckResult(null);
    try {
      const result = await postJson<{ ok: boolean; detail?: string; reason?: string }>(
        `/api/finance/balance-connections/${provider}/check`,
        { connectionId: id },
      );
      setCheckResult(result.ok ? (result.detail ?? "It works.") : (result.reason ?? "It did not work."));
      await onDone();
    } catch (err) {
      setCheckResult(err instanceof Error ? err.message : "The test could not be run.");
    } finally {
      setBusy(false);
    }
  }

  if (blocked) {
    return (
      <FieldShell field={field}>
        <Banner>{capability!.reason}</Banner>
      </FieldShell>
    );
  }

  return (
    <FieldShell field={field}>
      <div className="flex flex-col gap-2">
        {candidates && (
          <Card padding="p-2">
            <p className="text-2xs text-muted mb-1.5">Which one should this account use?</p>
            <div className="flex flex-col gap-0.5">
              {candidates.map((c) => (
                <button
                  key={c.externalId}
                  type="button"
                  disabled={busy}
                  onClick={() => choose(c)}
                  className="text-left text-xs text-body hover:bg-surface-mid/30 rounded px-2 py-1.5"
                >
                  {c.label}
                  {c.sublabel ? <span className="text-faint"> · {c.sublabel}</span> : null}
                </button>
              ))}
              {candidates.length === 0 && <p className="text-2xs text-faint px-2 py-1">Nothing available to connect.</p>}
            </div>
          </Card>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          {field.connect === "authorize" ? (
            <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={startAuthorize}>
              {field.satisfied ? "Reconnect" : "Sign in and connect"}
            </button>
          ) : (
            <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={loadCandidates}>
              {field.satisfied ? "Change account" : "Choose an account"}
            </button>
          )}

          {field.satisfied && capability?.canCheck && (
            <button type="button" className="btn-secondary btn-xxs" disabled={busy} onClick={runCheck}>
              Test it
            </button>
          )}
          {busy && <span className="text-2xs text-faint animate-pulse">working…</span>}
        </div>

        {checkResult && <p className="text-2xs text-muted">{checkResult}</p>}
      </div>
    </FieldShell>
  );
}

/** A figure only a person can supply, written as a manual_entries balance row. */
function OperatorBalanceField({
  field,
  account,
  onDone,
  onError,
}: {
  field: SetupFieldState;
  account: AccountRow;
  onDone: () => void | Promise<unknown>;
  onError: (message: string) => void;
}) {
  // Defaults to the month that has most recently ENDED -- the period a close is
  // actually waiting on, and the first one the snapshot will write. Defaulting
  // to the current month offers a month end that has not happened yet, which is
  // never a balance anyone can have read off anything. Earlier months are one
  // click away in the date input for an opening figure.
  const [asOfDate, setAsOfDate] = useState(() => {
    const now = new Date();
    // Day 0 of this month is the last day of the previous one.
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return prev.toISOString().slice(0, 10);
  });
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const cents = parseAmountInputCents(amount);
    // Two different failures, said differently. Typing "0" used to land here and
    // be told to "enter the balance as a number" — which it was, and which is
    // the error the owner hit. Zero is now a saveable balance, and the only
    // input left that cannot be read is one with no digits in it at all.
    if (cents === null) {
      onError(
        amount.trim() === ""
          ? "Enter a balance before saving."
          : "That is not an amount this can read. Type it like 4268.28, or -4268.28 for a negative balance.",
      );
      return;
    }
    setBusy(true);
    try {
      await postJson("/api/finance/balance-sources/operator-balance", {
        coaId: account.id,
        // Normalised here as well as server-side so a mid-month date entered by
        // hand lands on the month end it belongs to rather than being rejected.
        asOfDate: monthEnd(asOfDate),
        amountCents: cents,
      });
      setAmount("");
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save that balance.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FieldShell field={field}>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="date"
          value={asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)}
          className="inp-sm w-auto"
          aria-label="Month end this balance is for"
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(formatAmountInput(e.target.value))}
          className="inp-sm w-28 text-right font-mono"
          aria-label="Balance"
        />
        <button type="button" className="btn-primary btn-xxs" disabled={busy || amount === ""} onClick={save}>
          {busy ? "Saving…" : "Save balance"}
        </button>
      </div>
      <p className="text-2xs text-faint mt-1">
        Saved as a manual entry, the same as one typed under Finance → Transactions → Manual Entries.
      </p>
    </FieldShell>
  );
}

/** Everything else: a plain answer stored on the source's config. */
function ConfigField({
  field,
  account,
  source,
  allAccounts,
  users,
  onDone,
  onError,
}: {
  field: SetupFieldState;
  account: AccountRow;
  source: SourceEntry;
  /** Every balance-sheet account, for `account` fields. */
  allAccounts: AccountRow[];
  /** Everyone who can be named, for `user` fields. */
  users: UserRef[];
  onDone: () => void | Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(() => String(source.config[field.key] ?? ""));
  const [busy, setBusy] = useState(false);

  /**
   * The choices for an `account` field, built from the accounts this screen
   * already has rather than fetched again.
   *
   * The account itself is excluded: a sweep destination that is the source is
   * not a destination, and offering it invites a self-reference that would read
   * as configured while meaning nothing.
   */
  const accountOptions =
    field.kind === "account"
      ? allAccounts
          .filter((a) => a.id !== account.id)
          .filter((a) => !field.sections || (a.statementSection ? field.sections.includes(a.statementSection) : false))
          .map((a) => ({
            value: a.id,
            label: a.accountNumber ? `${a.accountNumber} · ${a.accountName}` : a.accountName,
          }))
      : [];

  /**
   * The choices for a `user` field. Deliberately every account rather than a
   * role-filtered subset: who counts a till or reads a loan statement is not a
   * question the permission model has an opinion about, and guessing wrong
   * would hide the one person the operator was looking for.
   */
  const userOptions = field.kind === "user" ? users.map((u) => ({ value: u.id, label: u.email })) : [];

  // A dropdown is a dropdown regardless of where its rows come from, so all
  // three kinds share one control and differ only in the list handed to it.
  const options =
    field.kind === "account" ? accountOptions : field.kind === "user" ? userOptions : (field.options ?? []);
  const isPicker = field.kind === "select" || field.kind === "account" || field.kind === "user";

  async function save() {
    setBusy(true);
    try {
      const parsed = field.kind === "number" ? Number(value) : value;
      if (field.kind === "number" && !Number.isFinite(parsed as number)) {
        onError(`${field.label} must be a number.`);
        return;
      }
      await linkConnection(account.id, source.methodKey, source.config, { [field.key]: parsed });
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FieldShell field={field}>
      <div className="flex items-center gap-2 flex-wrap">
        {isPicker ? (
          <select value={value} onChange={(e) => setValue(e.target.value)} className="inp-sm w-auto">
            <option value="">— choose —</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <input
            type={field.kind === "date" ? "date" : field.kind === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="inp-sm w-auto"
            aria-label={field.label}
          />
        )}
        <button type="button" className="btn-primary btn-xxs" disabled={busy || value === ""} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </FieldShell>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function MethodSetupPanel({
  method,
  account,
  source,
  allAccounts,
  users,
  providers,
  onRefresh,
  onClose,
}: {
  method: MethodMeta;
  account: AccountRow;
  source: SourceEntry;
  /** Every balance-sheet account, so an `account` field can offer them. */
  allAccounts: AccountRow[];
  /** Everyone who can be named, so a `user` field can offer them. */
  users: UserRef[];
  providers: Record<string, ProviderCapability>;
  onRefresh: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const setup = source.setup;

  return (
    // Never lower-cased: method labels carry proper nouns ("Bank balance from
    // Plaid"), and normalising the case turns them into "plaid".
    <Modal title={`${method.label} — setup`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-2xs text-faint mb-1">
            {account.accountNumber ? `${account.accountNumber} · ${account.accountName}` : account.accountName}
          </p>
          <p className="text-sm text-secondary">{method.summary}</p>
        </div>

        {error && <Banner>{error}</Banner>}

        {setup && setup.ready && (
          <Banner tone="success">Everything this calculation needs is set. It will run from now on.</Banner>
        )}

        <div className="flex flex-col gap-4">
          {(setup?.fields ?? []).map((field) => {
            const common = { field, account, onError: setError, onDone: onRefresh };
            if (field.kind === "connection") {
              return (
                <ConnectionField
                  key={field.key}
                  {...common}
                  source={source}
                  capability={field.provider ? providers[field.provider] : undefined}
                />
              );
            }
            if (field.kind === "operatorBalance") return <OperatorBalanceField key={field.key} {...common} />;
            return <ConfigField key={field.key} {...common} source={source} allAccounts={allAccounts} users={users} />;
          })}
        </div>

        {/* Immediate proof the setup worked, without leaving the panel. */}
        {account.liveBalance && (
          <div className="flex items-center justify-between border-t border-line pt-3">
            <span className="text-xs text-body">This account right now</span>
            <span className="font-mono text-sm tabular-nums text-strong">
              {formatCurrencyCents(account.liveBalance.cents)}
            </span>
          </div>
        )}
        {account.liveError && <Banner>{account.liveError}</Banner>}
      </div>
    </Modal>
  );
}
