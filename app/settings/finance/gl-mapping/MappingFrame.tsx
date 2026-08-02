"use client";
/**
 * The chrome every GL-mapping panel shares.
 *
 * Expenses, Counterparties and Sales Tax were three files that differed only in
 * their left-hand columns — each carried its own copy of the same load/error/
 * empty state machine, and the three drifted (one showed a save hint, one
 * didn't; the CoA empty state told you to "Go to Chart of Accounts" without
 * linking there). The state machine and the table shell live here now; each
 * panel supplies its own `<tr>`s, because that is the part that genuinely
 * differs and reads better written out than configured.
 *
 * Revenue does NOT use this. It is a collapsible category tree with bulk
 * mappers at three levels, not a flat table, and forcing it through here would
 * mean a frame that fits nothing well.
 */
import type { ReactNode } from "react";
import Banner from "@/app/components/ui/Banner";
import type { Tone } from "@/app/components/ui/tone";

const CHART_OF_ACCOUNTS_HREF = "/settings/finance/chart-of-accounts";

function Centered({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center text-center px-6">
      <div>
        <p className="text-sm text-secondary">{title}</p>
        <p className="text-xs text-faint mt-1">{hint}</p>
      </div>
    </div>
  );
}

export default function MappingFrame({
  loading,
  error,
  hasAccounts,
  rowCount,
  summary,
  summaryTone = "neutral",
  emptyRows,
  headers,
  footer,
  children,
}: {
  loading: boolean;
  error: string | null;
  /** False until a chart of accounts exists — nothing here can be mapped without one. */
  hasAccounts: boolean;
  rowCount: number;
  /** The "N of M mapped" line, which doubles as the seed hint when there are no rows. */
  summary: ReactNode;
  /** `danger` when something still needs resolving, `success` when fully mapped, `neutral` otherwise. */
  summaryTone?: Tone;
  emptyRows: { title: string; hint: ReactNode };
  headers: string[];
  footer: ReactNode;
  /** The panel's own `<tr>` rows. */
  children: ReactNode;
}) {
  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-2">
        <Banner tone={summaryTone}>{summary}</Banner>
      </div>

      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted">Loading…</p>
        </div>
      ) : !hasAccounts ? (
        <Centered
          title="Upload a chart of accounts first."
          hint={
            <>
              Nothing can be mapped until one exists —{" "}
              <a href={CHART_OF_ACCOUNTS_HREF} className="text-accent hover:underline">
                go to Chart of Accounts
              </a>
              .
            </>
          }
        />
      ) : rowCount === 0 ? (
        <Centered title={emptyRows.title} hint={emptyRows.hint} />
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="bg-surface border border-line rounded-lg overflow-hidden">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line">
                  {headers.map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-muted font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{children}</tbody>
            </table>
          </div>
          <p className="py-3 text-2xs text-faint">{footer}</p>
        </div>
      )}
    </>
  );
}
