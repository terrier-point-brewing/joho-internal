"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import PageHeader from "@/app/components/PageHeader";
import StickyHeader from "@/app/components/StickyHeader";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import { queryKeys } from "@/lib/query-keys";
import type { AlertGroup, AlertItem, AlertSection } from "@/lib/alerts/types";
import { SECTION_LABEL, SECTION_ORDER } from "@/lib/alerts/types";

export interface HomeAlertsResponse {
  today: string;
  generated_at: string;
  groups: AlertGroup[];
  counts: { total: number; danger: number };
  email_enabled: boolean;
}

/** How many items a group shows before offering the rest behind its link. */
const PREVIEW = 6;

export default function HomeDashboard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.home.alerts(),
    queryFn: () => fetchJson<HomeAlertsResponse>("/api/home/alerts"),
    staleTime: 60_000,
  });

  const groups = data?.groups ?? [];
  const sections = SECTION_ORDER.filter((s) => groups.some((g) => g.section === s));

  return (
    <main className="px-4 sm:px-6">
      <StickyHeader divider>
        <PageHeader
          title="Home"
          description="Everything that needs a decision or an action from you, in one place. Each list links to where the work gets done."
        />
      </StickyHeader>

      <div className="mt-4 pb-4 sm:pb-8 flex flex-col gap-4">
        {error && <Banner>{(error as Error).message}</Banner>}
        {isLoading && <p className="text-sm text-muted">Checking…</p>}

        {data && (
          <>
            <Summary data={data} refreshing={isFetching} onRefresh={() => refetch()} />

            {sections.length === 0 && (
              <Card>
                <p className="text-sm text-secondary">
                  Nothing here is yours to act on yet. The alert center lists work for the areas your account can open;
                  an admin can widen that under Settings → Environment → Users.
                </p>
              </Card>
            )}

            {sections.map((section) => (
              <SectionBlock key={section} section={section} groups={groups.filter((g) => g.section === section)} />
            ))}
          </>
        )}
      </div>
    </main>
  );
}

function Summary({ data, refreshing, onRefresh }: { data: HomeAlertsResponse; refreshing: boolean; onRefresh: () => void }) {
  const { total, danger } = data.counts;
  const clear = total === 0;
  const failed = data.groups.filter((g) => g.error).length;
  return (
    <Card className={clear ? "border-success-border" : danger > 0 ? "border-danger-border" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">Right now</div>
          <div className={`text-base sm:text-xl font-semibold mt-1 ${clear ? "text-success" : danger > 0 ? "text-danger" : "text-primary"}`}>
            {clear ? "All clear" : `${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`}
          </div>
          <div className="text-xs text-secondary mt-1">
            {!clear && danger > 0 && <span className="text-danger">{danger} urgent</span>}
            {!clear && danger > 0 && <span className="text-faint"> · </span>}
            {data.email_enabled
              ? "You also get this list by email each morning."
              : "You do not get this list by email. An admin can switch that on under Settings → Environment → Users."}
            {failed > 0 && <span className="text-danger"> {failed} check{failed === 1 ? "" : "s"} could not run — see below.</span>}
          </div>
        </div>
        <button className="btn-secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Checking…" : "Check again"}
        </button>
      </div>
    </Card>
  );
}

function SectionBlock({ section, groups }: { section: AlertSection; groups: AlertGroup[] }) {
  const open = groups.filter((g) => g.items.length > 0 || g.error);
  const clear = groups.filter((g) => g.items.length === 0 && !g.error);
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary mb-2">{SECTION_LABEL[section]}</h3>
      <div className="flex flex-col gap-3">
        {open.map((g) => <GroupCard key={g.key} group={g} />)}
        {clear.length > 0 && (
          <Card padding="p-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {clear.map((g) => (
                <Link key={g.key} href={g.href} className="hover:text-body">
                  <span className="text-success">✓</span> {g.label}
                </Link>
              ))}
            </div>
          </Card>
        )}
      </div>
    </section>
  );
}

function GroupCard({ group }: { group: AlertGroup }) {
  const danger = group.items.filter((i) => i.severity === "danger").length;
  const shown = group.items.slice(0, PREVIEW);
  const rest = group.items.length - shown.length;
  return (
    <Card className={danger > 0 ? "border-danger-border" : ""}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-strong truncate">{group.label}</h3>
          {group.items.length > 0 && (
            <Badge tone={danger > 0 ? "danger" : "info"}>{group.items.length}</Badge>
          )}
        </div>
        <Link href={group.href} className="btn-secondary btn-xxs whitespace-nowrap">Open</Link>
      </div>

      {group.error && (
        <Banner className="mt-3">Could not check this: {group.error}</Banner>
      )}

      {shown.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-line/60">
          {shown.map((item) => <ItemRow key={item.key} item={item} />)}
        </ul>
      )}
      {rest > 0 && (
        <Link href={group.href} className="block mt-2 text-xs text-muted hover:text-body">
          and {rest} more →
        </Link>
      )}
    </Card>
  );
}

function ItemRow({ item }: { item: AlertItem }) {
  return (
    <li>
      <Link href={item.href} className="flex gap-3 py-2 group">
        <span
          aria-hidden
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.severity === "danger" ? "bg-danger-emphasis" : "bg-info-emphasis"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-body group-hover:text-strong">{item.title}</span>
          {item.detail && <span className="block text-xs text-muted mt-0.5">{item.detail}</span>}
        </span>
        {item.when && <span className="text-xs text-faint font-mono tabular-nums whitespace-nowrap mt-0.5">{item.when}</span>}
      </Link>
    </li>
  );
}
