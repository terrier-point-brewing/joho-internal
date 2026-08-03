import FinanceNav from "../FinanceNav";
import PageHeader from "@/app/components/PageHeader";
import Card from "@/app/components/ui/Card";
import { TAB_ROW, tabItem } from "@/app/components/ui/tabStyles";

// What the browser paints while page.tsx builds the requested statement on the
// server. This is not decoration -- it is the half of that prefetch that keeps
// it from being a regression. Next wraps page.tsx in a Suspense boundary
// because this file exists, so the layout and this skeleton are flushed
// immediately (~TTFB) and the statement streams in behind them. Delete this and
// the same prefetch turns the first second of the page into a blank document.
//
// The parts that are known before any data is fetched -- the sub-nav, the page
// title, the three statement tabs -- are rendered for real rather than as grey
// blocks, so the swap to the loaded page moves nothing that was already legible.
// Everything below that is a placeholder at the real element's height, in the
// same order FinancialsClient renders it: KPI strip, filter bar, table.

/** Matches KpiTile's height: label, value, sub-label. */
function KpiTileSkeleton() {
  return (
    <Card padding="p-3" className="flex flex-col gap-1 min-w-0">
      <div className="h-3 w-20 rounded bg-surface-mid/70 animate-pulse" />
      <div className="h-5 sm:h-7 w-28 rounded bg-surface-mid/70 animate-pulse" />
      <div className="h-3 w-16 rounded bg-surface-mid/50 animate-pulse" />
    </Card>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <div className="flex items-center justify-between">
          <PageHeader title="Financials" description="Consolidated P&L, Balance Sheet, and Cash Flow — persisted, CoA-mapped data" />
          <div className="h-7 w-40 rounded bg-surface-mid/60 animate-pulse" />
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2 mt-2">
          {/* Static twin of the real TabBar: same classes, no handlers. P&L is
              shown active because it is what page.tsx defaults to; a
              ?statement= deep link corrects it when the real bar streams in. */}
          <div className={`${TAB_ROW} mb-0`} aria-hidden>
            <span className={tabItem(true)}>P&amp;L</span>
            <span className={tabItem(false)}>Balance Sheet</span>
            <span className={tabItem(false)}>Cash Flow</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-6 pt-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
          {Array.from({ length: 5 }).map((_, i) => <KpiTileSkeleton key={i} />)}
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-4">
          <div className="h-7 w-52 rounded bg-surface-mid/60 animate-pulse" />
          <div className="h-5 w-72 rounded bg-surface-mid/50 animate-pulse" />
          <div className="h-5 w-40 rounded bg-surface-mid/50 animate-pulse" />
        </div>

        <div className="bg-surface border border-line rounded-lg overflow-hidden p-4 space-y-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-7 w-full rounded bg-surface-mid/50 animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
