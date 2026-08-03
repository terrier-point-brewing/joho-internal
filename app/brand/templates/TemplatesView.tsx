"use client";

import { useState } from "react";
import PageHeader from "@/app/components/PageHeader";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import TabBar from "@/app/components/TabBar";
import type { Tone } from "@/app/components/ui/tone";
import type { BrandTemplate, TemplateMedium } from "@/lib/brand/templates";
import type { BrandSeason } from "@/lib/brand/seasons";
import {
  useActivateSeason,
  useCreateSeason,
  useCreateTemplate,
  useSeasons,
  useTemplateAction,
  useTemplates,
} from "./useTemplates";

const MEDIA: TemplateMedium[] = ["label", "menu", "social", "apparel", "signage", "collateral"];

const TEMPLATE_TONE: Record<BrandTemplate["status"], Tone> = {
  published: "success",
  draft: "accent",
  archived: "neutral",
};

const SEASON_TONE: Record<BrandSeason["status"], Tone> = {
  active: "success",
  draft: "accent",
  archived: "neutral",
};

/**
 * Templates and Seasons — the authoring surface for the render pipeline.
 *
 * Nothing renders yet. This is the layer beneath: a template's slots and
 * renditions, and the season every `motif` slot resolves against. Slot editing
 * itself is next; a template is created here and its slots are what the render
 * phase fills in.
 */
export default function TemplatesView() {
  const [tab, setTab] = useState<"templates" | "seasons">("templates");

  const { data: templates = [], isLoading, error } = useTemplates();
  const { data: seasons = [] } = useSeasons();
  const createTemplate = useCreateTemplate();
  const templateAction = useTemplateAction();
  const createSeason = useCreateSeason();
  const activateSeason = useActivateSeason();

  const [name, setName] = useState("");
  const [medium, setMedium] = useState<TemplateMedium>("label");
  const [seasonName, setSeasonName] = useState("");

  const activeSeason = seasons.find((s) => s.status === "active") ?? null;
  const actionError = templateAction.error ?? createTemplate.error ?? activateSeason.error;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader
          title="Templates"
          description="Layouts, their slots, and the season every motif resolves against."
        />
        <TabBar
          tabs={[
            { key: "templates", label: "Templates" },
            { key: "seasons", label: "Seasons" },
          ]}
          activeKey={tab}
          onSelect={(k) => setTab(k as "templates" | "seasons")}
          className="mb-0"
        />
      </div>
      <div className="flex-1 overflow-auto px-4 sm:px-6 pb-4 sm:pb-8 pt-4 flex flex-col gap-4">

      {error && <Banner tone="danger">{(error as Error).message}</Banner>}
      {actionError && <Banner tone="danger">{(actionError as Error).message}</Banner>}

      {/* A template with a motif slot cannot render without one, so the state of
          the rotation belongs on this page rather than only inside Seasons. */}
      {!activeSeason && (
        <Banner tone="info">
          No season is active. Templates with a motif slot will fail validation until one is.
        </Banner>
      )}

      {tab === "templates" && (
        <>
          <Card>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                createTemplate.mutate(
                  {
                    key: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
                    name: name.trim(),
                    medium,
                  },
                  { onSuccess: () => setName("") },
                );
              }}
            >
              <input
                className="inp-sm flex-1 min-w-48"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name — e.g. Beer label"
                aria-label="Template name"
              />
              <select
                className="inp-sm w-40"
                value={medium}
                onChange={(e) => setMedium(e.target.value as TemplateMedium)}
                aria-label="Medium"
              >
                {MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn-primary btn-xxs" disabled={createTemplate.isPending}>
                Add template
              </button>
            </form>
          </Card>

          {isLoading && <p className="text-sm text-muted">Loading…</p>}
          {!isLoading && templates.length === 0 && (
            <p className="text-sm text-faint">
              No templates yet. The beer label is the one to build first — it is the most
              constrained, so it proves the slot and constraint pipeline.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {templates.map((t) => (
              <Card key={t.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-primary font-medium">{t.name}</span>
                  <span className="text-2xs text-faint">
                    {t.key} · v{t.version} · {t.medium}
                  </span>
                  <Badge tone={TEMPLATE_TONE[t.status]}>{t.status}</Badge>
                  <span className="text-2xs text-muted">
                    {t.slots?.length ?? 0} slot{(t.slots?.length ?? 0) === 1 ? "" : "s"} ·{" "}
                    {t.renditions?.length ?? 0} rendition
                    {(t.renditions?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                  <div className="ml-auto flex gap-1.5">
                    {t.status === "draft" && (
                      <button
                        type="button"
                        className="btn-primary btn-xxs"
                        disabled={templateAction.isPending}
                        onClick={() => templateAction.mutate({ id: t.id, action: "publish" })}
                      >
                        Publish
                      </button>
                    )}
                    {t.status === "published" && (
                      // Editing a published version in place would rewrite what
                      // already-shipped outputs claim they were made from.
                      <button
                        type="button"
                        className="btn-secondary btn-xxs"
                        disabled={templateAction.isPending}
                        onClick={() => templateAction.mutate({ id: t.id, action: "draft-next" })}
                      >
                        Draft v{t.version + 1}
                      </button>
                    )}
                  </div>
                </div>
                {!t.base_svg_path && (
                  <p className="text-2xs text-faint mt-1.5">No base SVG attached yet.</p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === "seasons" && (
        <>
          <Card>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!seasonName.trim()) return;
                createSeason.mutate(
                  { name: seasonName.trim() },
                  { onSuccess: () => setSeasonName("") },
                );
              }}
            >
              <input
                className="inp-sm flex-1 min-w-48"
                value={seasonName}
                onChange={(e) => setSeasonName(e.target.value)}
                placeholder="Season name — e.g. Season 1"
                aria-label="Season name"
              />
              <button type="submit" className="btn-primary btn-xxs" disabled={createSeason.isPending}>
                Add season
              </button>
            </form>
          </Card>

          {seasons.length === 0 && (
            <p className="text-sm text-faint">
              No seasons yet. A season carries the two things that rotate — the ground color and
              the chop glyph. Everything else about the chop is fixed in the canon.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {seasons.map((s) => (
              <Card key={s.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-primary font-medium">{s.name}</span>
                  <Badge tone={SEASON_TONE[s.status]}>{s.status}</Badge>
                  {s.background_hex && (
                    <span className="flex items-center gap-1 text-2xs text-muted">
                      <span
                        className="inline-block w-3 h-3 rounded-sm border border-line"
                        style={{ backgroundColor: s.background_hex }}
                      />
                      {s.background_hex}
                    </span>
                  )}
                  {!s.chop_glyph_asset_id && (
                    <span className="text-2xs text-faint">no chop glyph</span>
                  )}
                  {s.status !== "active" && (
                    <button
                      type="button"
                      className="btn-primary btn-xxs ml-auto"
                      disabled={activateSeason.isPending}
                      onClick={() => activateSeason.mutate(s.id)}
                    >
                      Make active
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      </div>
    </div>
  );
}
