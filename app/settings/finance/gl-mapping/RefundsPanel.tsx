"use client";
/**
 * Where a refund posts, when netting it against revenue would be wrong.
 *
 * Every Square refund defaults to GL 4999 Sales Returns & Refunds, which is the
 * right answer whenever the thing refunded was a sale. It is the wrong answer
 * whenever it was not: the taproom's Keg Deposit and Pump Deposit items are
 * coded to GL 2420, so taking one credits a liability and handing it back has to
 * debit that same liability. Sent to 4999 instead, the deposit account only ever
 * grows — which is what it had been doing.
 *
 * A rule here says "refunds of this account go to that account", and the usual
 * shape is an account pointing at ITSELF. That reads oddly for a second and is
 * exactly right: it means the money goes back where it came from, rather than to
 * contra-revenue. The footer says so, because an operator seeing "2420 → 2420"
 * with no explanation would reasonably assume it was a mistake.
 *
 * Unlike its sibling panels, rows here are AUTHORED rather than seeded — there is
 * no set of observed things to enumerate, only rules somebody decided to make.
 * So this one carries an add row, and an empty table is a normal state rather
 * than a prompt to go sync something.
 */
import { useState, type ReactNode } from "react";
import AccountSelect, { type CoARef } from "@/app/finance/AccountSelect";
import SaveHint from "@/app/components/ui/SaveHint";
import ToggleChip from "@/app/components/ui/ToggleChip";
import type { Tone } from "@/app/components/ui/tone";
import MappingFrame from "./MappingFrame";
import { useMappingData } from "./useMappingData";

const ROUTING_URL = "/api/finance/settings/refund-routing";

interface CoaJoin { account_name: string; account_number: string | null }

interface RoutingRow {
  id: string;
  source_chart_of_accounts_id: string;
  target_chart_of_accounts_id: string;
  active: boolean;
  note: string | null;
  source_account: CoaJoin | null;
  target_account: CoaJoin | null;
}

function accountLabel(coa: CoaJoin | null): string {
  if (!coa) return "—";
  const leaf = coa.account_name.split(":").pop()?.trim() ?? coa.account_name;
  return coa.account_number ? `${coa.account_number} · ${leaf}` : leaf;
}

export default function RefundsPanel({ selector }: { selector?: ReactNode }) {
  const { accounts, rows, loading, error, setError, reload } =
    useMappingData<RoutingRow>(ROUTING_URL, "Failed to load refund routing rules.");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newSource, setNewSource] = useState<string | null>(null);
  const [newTarget, setNewTarget] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function patch(row: RoutingRow, body: Record<string, unknown>) {
    setSavingId(row.id);
    setError(null);
    const res = await fetch(ROUTING_URL, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: row.id, ...body }),
    });
    setSavingId(null);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "Could not save that change.");
      return;
    }
    // Reloaded rather than patched in place: the account joins come from the
    // server, and a rule turned back on can collide with another one, which
    // only the server knows about.
    await reload();
  }

  async function handleAdd() {
    if (!newSource || !newTarget) return;
    setAdding(true);
    setError(null);
    const res = await fetch(ROUTING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_chart_of_accounts_id: newSource,
        target_chart_of_accounts_id: newTarget,
      }),
    });
    setAdding(false);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error ?? "Could not add that rule.");
      return;
    }
    setNewSource(null);
    setNewTarget(null);
    await reload();
  }

  async function handleDelete(row: RoutingRow) {
    setSavingId(row.id);
    setError(null);
    const res = await fetch(`${ROUTING_URL}?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
    setSavingId(null);
    if (!res.ok) { setError("Could not remove that rule."); return; }
    await reload();
  }

  const activeCount = rows.filter((r) => r.active).length;
  // Neutral throughout: unlike the mapping panels, there is no "unmapped" state
  // to chase here. No rules is a perfectly correct configuration — it just means
  // every refund is contra-revenue.
  const summaryTone: Tone = "neutral";

  return (
    <MappingFrame
      selector={selector}
      loading={loading}
      error={error}
      hasAccounts={accounts.length > 0}
      // Forced non-zero so the add row is reachable on a fresh install; the
      // frame's empty state would otherwise hide the only way to create a rule.
      rowCount={rows.length + 1}
      summary={rows.length === 0
        ? "No exceptions — every refund is treated as money coming back off a sale."
        : `${activeCount} of ${rows.length} refund rule${rows.length === 1 ? "" : "s"} in effect`}
      summaryTone={summaryTone}
      emptyRows={{ title: "", hint: "" }}
      headers={["Refunds of this account", "Post to this account instead", "In effect", ""]}
      footer={
        <>
          A refund normally counts as a sale coming back, so it posts to Sales Returns &amp;
          Refunds. That is wrong when the original charge was never a sale. A returnable keg or
          pump deposit is the case this exists for: taking the deposit records money you owe the
          customer, and handing it back settles it — netting it against beer sales would leave
          the deposit on the books forever.
          {" "}A rule pointing an account <em>at itself</em> is the normal shape and is not a
          mistake: it means the refund goes back where the charge came from.
          {" "}Rules apply to refunds Square gives you no line detail for — till refunds and ones
          raised by hand in the Square dashboard. A refund is only routed when its amount matches
          that account&apos;s share of the original ticket exactly, tax included; a partial refund
          off a mixed ticket cannot be attributed safely and stays on Sales Returns &amp; Refunds.
          {" "}Refunds the app issued against an invoice already carry their own line detail and
          ignore these rules.
          {" "}Changes take effect on the next refund sync — they do not re-code refunds already
          imported.
        </>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className="border-t border-line/40 hover:bg-surface-mid/20">
          <td className="px-4 py-2">
            <span className="text-body truncate">{accountLabel(row.source_account)}</span>
          </td>
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <AccountSelect
                value={row.target_chart_of_accounts_id}
                onChange={(id) => id && patch(row, { target_chart_of_accounts_id: id })}
                accounts={accounts}
                placeholder="— choose an account —"
                shortLabel
                className="w-full max-w-[360px]"
              />
            </div>
            <SaveHint saving={savingId === row.id} />
          </td>
          <td className="px-4 py-2">
            <ToggleChip active={row.active} onClick={() => patch(row, { active: !row.active })}>
              {row.active ? "Yes" : "No"}
            </ToggleChip>
          </td>
          <td className="px-4 py-2 text-right">
            <button
              type="button"
              onClick={() => handleDelete(row)}
              className="btn-danger btn-xxs"
              title="Remove this rule entirely. Turning it off instead keeps a record of what refunds used to do."
            >
              Remove
            </button>
          </td>
        </tr>
      ))}

      <tr className="border-t border-line/40 bg-surface-mid/10">
        <td className="px-4 py-2">
          <AccountSelect
            value={newSource}
            onChange={setNewSource}
            accounts={accounts}
            placeholder="— refunds of… —"
            shortLabel
            className="w-full max-w-[360px]"
          />
        </td>
        <td className="px-4 py-2">
          <AccountSelect
            value={newTarget}
            onChange={setNewTarget}
            accounts={accounts}
            placeholder="— post to… —"
            shortLabel
            className="w-full max-w-[360px]"
          />
        </td>
        <td className="px-4 py-2" colSpan={2}>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newSource || !newTarget || adding}
            className="btn-primary btn-xxs disabled:opacity-40"
          >
            {adding ? "Adding…" : "Add rule"}
          </button>
        </td>
      </tr>
    </MappingFrame>
  );
}
