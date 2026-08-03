"use client";

// Label component — gathers the inputs a label chassis needs and tracks the
// three stages of getting a label made:
//   1. Illustration — compose the artist request (pre-filled from the brand
//      guide + this release's card), track the commission, attach the final
//      art (brand_assets, kind `label_art`).
//   2. Regulatory — submission and approval of the finished label.
//   3. Print order — printer, quantity, specs, order out / stock received.
// Plus the design inputs that already lived here: Tier-2 palette + chop.
// SVG chassis generation plugs in here later — by the time these stages are
// done, every chassis input is gathered.

import { useMemo, useState } from "react";
import Banner from "@/app/components/ui/Banner";
import TabBar from "@/app/components/TabBar";
import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";
import {
  illustrationStatus,
  labelComponentStatus,
  printOrderStatus,
  regulatoryStatus,
  type BrandLabel,
  type StageStatus,
  type Tier2Palette,
} from "@/lib/brand/labels";
import { usePackagingQuery, useRecipesQuery } from "@/app/production/hooks/queries";
import { useSeasons } from "../templates/useTemplates";
import { useAssets } from "../assets/useAssets";
import type { ReleaseComponentContext, ReleaseComponentDef } from "./componentDef";
import { useCreateLabel, useUpdateLabel } from "./useLabels";
import { COMPONENT_STATUS_META, Field } from "./bits";
import GuidePanel from "./GuidePanel";
import { RELEASE_COMPONENT_TITLES } from "@/lib/brand/releases";

type FacetKey = "illustration" | "regulatory" | "print" | "palette" | "chop";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "illustration", label: "Illustration" },
  { key: "regulatory", label: "Regulatory" },
  { key: "print", label: "Print order" },
  { key: "palette", label: "Tier-2 palette" },
  { key: "chop", label: "Chop glyph" },
];

function LabelEditor({ ctx }: { ctx: ReleaseComponentContext }) {
  const { release, label } = ctx;
  const createLabel = useCreateLabel();

  if (!label) {
    // Backfilled releases always have one; this is the recovery path only.
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-secondary">This release has no label record yet.</p>
        <button
          className="btn-primary self-start"
          disabled={createLabel.isPending}
          onClick={() => createLabel.mutate({ release_id: release.id, name: release.name })}
        >
          Start the label
        </button>
      </div>
    );
  }
  return <LabelStages key={label.id} ctx={ctx} label={label} />;
}

function LabelStages({ ctx, label }: { ctx: ReleaseComponentContext; label: BrandLabel }) {
  const { release, guide, homage } = ctx;
  const updateLabel = useUpdateLabel();
  const { data: seasons = [] } = useSeasons();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const chopAssets = useAssets("chop_glyph");
  const artAssets = useAssets("label_art");

  const [facet, setFacet] = useState<FacetKey>("illustration");
  const [draft, setDraft] = useState<BrandLabel>({
    ...label,
    illustration: label.illustration ?? {},
    regulatory: label.regulatory ?? {},
    print_order: label.print_order ?? {},
  });

  const set = (patch: Partial<BrandLabel>) => setDraft((d) => ({ ...d, ...patch }));
  const setIll = (patch: Partial<BrandLabel["illustration"]>) =>
    set({ illustration: { ...draft.illustration, ...patch } });
  const setReg = (patch: Partial<BrandLabel["regulatory"]>) =>
    set({ regulatory: { ...draft.regulatory, ...patch } });
  const setPrint = (patch: Partial<BrandLabel["print_order"]>) =>
    set({ print_order: { ...draft.print_order, ...patch } });
  const setPalette = (colors: Tier2Palette["colors"]) => set({ tier2_palette: { colors } });

  const season = seasons.find((s) => s.id === release.season_id) ?? null;
  const recipe = recipes.find((r) => r.id === release.recipe_id) ?? null;

  // Print-stage context from Production: the label SKUs this design could
  // print onto, live stock for the linked one, and any container of the
  // linked recipe still missing a product code (the barcode needs it before
  // the order goes out).
  const labelSkus = packagingItems.filter((p) => p.type === "label");
  const linkedSku = labelSkus.find((p) => p.id === draft.packaging_item_id) ?? null;
  const codelessContainers = ctx.containers.filter((l) => !l.product_code);

  const composedBrief = useMemo(() => {
    const lines = [
      `Illustration request — "${release.name}"${season ? ` (${season.name}${release.episode ? `, Episode ${release.episode}` : ""})` : ""}`,
      "",
      release.story_line ? `Story line (printed verbatim on the label): ${release.story_line}` : null,
      release.menu_description ? `Menu description: ${release.menu_description}` : null,
      recipe ? `Beer style: ${recipe.style ?? recipe.beer_name}` : null,
      season?.cultural_lean ? `Season's cultural lean: ${season.cultural_lean}` : null,
      "",
      // The chassis narrative the guide panel above shows, quoted into the
      // commission so the artist reads the same words the founder published.
      guide.label.intro ? `From our brand guide: ${guide.label.intro}` : null,
      homage || null,
      "",
      "Requirements:",
      "- The illustration lives inside a bordered art window; compose for that frame.",
      "- No title-in-art typography — name and style are typeset by the label chassis, never painted into the art.",
      "- Illustrate the single moment the release's name points to.",
    ].filter((l): l is string => l !== null);
    return lines.join("\n");
  }, [release, season, recipe, guide, homage]);

  const stageChips: { label: string; status: StageStatus }[] = [
    { label: "Illustration", status: illustrationStatus(draft.illustration) },
    { label: "Regulatory", status: regulatoryStatus(draft.regulatory) },
    { label: "Print", status: printOrderStatus(draft.print_order) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <GuidePanel entry={guide.label} />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <TabBar tabs={FACETS} activeKey={facet} onSelect={setFacet} />
        <div className="flex items-center gap-2 shrink-0">
          {stageChips.map((s) => (
            <span key={s.label} className={`text-2xs ${COMPONENT_STATUS_META[s.status].tone === "success" ? "text-success" : s.status === "in_progress" ? "text-info" : "text-faint"}`}>
              {s.status === "done" ? "●" : s.status === "in_progress" ? "◐" : "○"} {s.label}
            </span>
          ))}
        </div>
      </div>

      {facet === "illustration" && (
        <div className="flex flex-col gap-3 max-w-xl">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-secondary">Request to the artist</span>
            <button
              className="btn-secondary"
              onClick={() => setIll({ request_brief: composedBrief })}
              title="Compose from the brand guide and this release's card"
            >
              Compose from guide + card
            </button>
          </div>
          <textarea
            className="inp font-mono text-xs"
            rows={10}
            placeholder="Compose the commission request here, then send it to the artist."
            value={draft.illustration.request_brief ?? ""}
            onChange={(e) => setIll({ request_brief: e.target.value })}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Artist">
              <input className="inp" value={draft.illustration.artist_name ?? ""} onChange={(e) => setIll({ artist_name: e.target.value })} />
            </Field>
            <Field label="Artist contact">
              <input className="inp" value={draft.illustration.artist_contact ?? ""} onChange={(e) => setIll({ artist_contact: e.target.value })} />
            </Field>
            <Field label="Requested on">
              <input type="date" className="inp" value={draft.illustration.requested_at ?? ""} onChange={(e) => setIll({ requested_at: e.target.value || null })} />
            </Field>
            <Field label="Expected delivery">
              <input type="date" className="inp" value={draft.illustration.expected_delivery ?? ""} onChange={(e) => setIll({ expected_delivery: e.target.value || null })} />
            </Field>
          </div>
          <Field label="Notes">
            <textarea className="inp" rows={2} value={draft.illustration.notes ?? ""} onChange={(e) => setIll({ notes: e.target.value })} />
          </Field>
          <div>
            <p className="text-xs text-secondary mb-1">Final illustration file(s)</p>
            <ArtPicker
              assets={artAssets.data ?? []}
              selectedIds={draft.illustration.asset_ids ?? []}
              onToggle={(id) => {
                const current = draft.illustration.asset_ids ?? [];
                setIll({
                  asset_ids: current.includes(id) ? current.filter((a) => a !== id) : [...current, id],
                });
              }}
            />
          </div>
        </div>
      )}

      {facet === "regulatory" && (
        <div className="flex flex-col gap-3 max-w-lg">
          <p className="text-xs text-muted">
            The finished label goes to the regulator; record the submission and the outcome here.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Submitted on">
              <input type="date" className="inp" value={draft.regulatory.submitted_at ?? ""} onChange={(e) => setReg({ submitted_at: e.target.value || null })} />
            </Field>
            <Field label="Filing / approval reference">
              <input className="inp" value={draft.regulatory.reference ?? ""} onChange={(e) => setReg({ reference: e.target.value })} />
            </Field>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.regulatory.approved ?? false}
              onChange={(e) =>
                setReg({
                  approved: e.target.checked,
                  approved_at: e.target.checked
                    ? (draft.regulatory.approved_at ?? new Date().toISOString().slice(0, 10))
                    : null,
                })
              }
            />
            <span className="text-sm text-body">Approval received</span>
          </label>
          {draft.regulatory.approved && (
            <Field label="Approved on">
              <input type="date" className="inp max-w-48" value={draft.regulatory.approved_at ?? ""} onChange={(e) => setReg({ approved_at: e.target.value || null })} />
            </Field>
          )}
          <Field label="Notes">
            <textarea className="inp" rows={2} value={draft.regulatory.notes ?? ""} onChange={(e) => setReg({ notes: e.target.value })} />
          </Field>
        </div>
      )}

      {facet === "print" && (
        <div className="flex flex-col gap-3 max-w-lg">
          {codelessContainers.length > 0 && (
            <Banner tone="info">
              {codelessContainers.length === 1
                ? `"${codelessContainers[0].packaging_variations?.name ?? "One container"}" has no product code yet`
                : `${codelessContainers.length} of this recipe's containers have no product code yet`}
              {" "}— the barcode needs it before this order goes out. Register codes on the Product Codes card.
            </Banner>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Printer">
              <input className="inp" value={draft.print_order.printer ?? ""} onChange={(e) => setPrint({ printer: e.target.value })} />
            </Field>
            <Field label="Quantity">
              <input
                type="number" min="0" step="1" className="inp"
                value={draft.print_order.quantity ?? ""}
                onChange={(e) => setPrint({ quantity: e.target.value ? parseInt(e.target.value) : null })}
              />
            </Field>
            <Field label="Order sent on">
              <input type="date" className="inp" value={draft.print_order.ordered_at ?? ""} onChange={(e) => setPrint({ ordered_at: e.target.value || null })} />
            </Field>
            <Field label="Prints onto label SKU">
              <select
                className="inp"
                value={draft.packaging_item_id ?? ""}
                onChange={(e) => set({ packaging_item_id: e.target.value || null })}
              >
                <option value="">— none linked —</option>
                {labelSkus.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {linkedSku ? (
            <p className="text-xs text-secondary">
              Live stock for {linkedSku.name}:{" "}
              <span className={`tabular-nums font-medium ${linkedSku.stock_quantity > 0 ? "text-success" : "text-danger"}`}>
                {linkedSku.stock_quantity.toLocaleString()}
              </span>{" "}
              on hand. Receiving happens in Production → Inventory, and this number follows it —
              there&apos;s no separate &ldquo;received&rdquo; to keep in sync here.
            </p>
          ) : (
            <p className="text-xs text-muted">
              Link the Production label SKU this design prints onto to see live stock here.
              {labelSkus.length === 0 && " (No label items in Packaging yet — create one in Production.)"}
            </p>
          )}
          <Field label="Specs">
            <textarea
              className="inp" rows={3}
              placeholder="Substrate, finish, dimensions, dieline…"
              value={draft.print_order.specs ?? ""}
              onChange={(e) => setPrint({ specs: e.target.value })}
            />
          </Field>
          <Field label="Notes">
            <textarea className="inp" rows={2} value={draft.print_order.notes ?? ""} onChange={(e) => setPrint({ notes: e.target.value })} />
          </Field>
        </div>
      )}

      {facet === "palette" && (
        <div className="flex flex-col gap-2">
          {draft.tier2_palette.colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#000000"}
                onChange={(e) => {
                  const next = [...draft.tier2_palette.colors];
                  next[i] = { ...c, hex: e.target.value };
                  setPalette(next);
                }}
                className="h-8 w-8 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
              />
              <input className="inp-sm" placeholder="Name" value={c.name} onChange={(e) => { const n = [...draft.tier2_palette.colors]; n[i] = { ...c, name: e.target.value }; setPalette(n); }} />
              <input className="inp-sm" placeholder="Note" value={c.note ?? ""} onChange={(e) => { const n = [...draft.tier2_palette.colors]; n[i] = { ...c, note: e.target.value }; setPalette(n); }} />
              <button className="btn-danger" onClick={() => setPalette(draft.tier2_palette.colors.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button
            className="btn-secondary self-start"
            onClick={() => setPalette([...draft.tier2_palette.colors, { name: "", hex: "#26355d" }])}
          >
            Add color
          </button>
        </div>
      )}

      {facet === "chop" && (
        <ChopPicker
          assets={chopAssets.data ?? []}
          selectedId={draft.chop_glyph_asset_id}
          onSelect={(id) => set({ chop_glyph_asset_id: id })}
        />
      )}

      {updateLabel.error && <Banner tone="danger">{(updateLabel.error as Error).message}</Banner>}
      <button
        className="btn-primary self-start"
        disabled={updateLabel.isPending}
        onClick={() =>
          updateLabel.mutate({
            id: label.id,
            patch: {
              tier2_palette: { colors: draft.tier2_palette.colors },
              chop_glyph_asset_id: draft.chop_glyph_asset_id,
              illustration: draft.illustration,
              regulatory: draft.regulatory,
              print_order: draft.print_order,
              packaging_item_id: draft.packaging_item_id,
            },
          })
        }
      >
        {updateLabel.isPending ? "Saving…" : "Save label"}
      </button>
    </div>
  );
}

function ArtPicker({
  assets,
  selectedIds,
  onToggle,
}: {
  assets: BrandAsset[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const approved = assets.filter((a) => a.status === "approved");
  if (approved.length === 0) {
    return (
      <p className="text-xs text-muted">
        No approved illustration assets yet — upload the delivered file(s) in Assets under
        &ldquo;label_art&rdquo;, approve them, then attach them here.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      {approved.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onToggle(a.id)}
          title={a.title ?? a.variant}
          className={`w-20 h-20 rounded border overflow-hidden ${selectedIds.includes(a.id) ? "border-accent ring-1 ring-accent" : "border-line"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={assetFileUrl(a.id)} alt={a.alt_text ?? a.variant} className="w-full h-full object-contain" />
        </button>
      ))}
    </div>
  );
}

function ChopPicker({
  assets,
  selectedId,
  onSelect,
}: {
  assets: BrandAsset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const approved = assets.filter((a) => a.status === "approved");
  if (approved.length === 0) {
    return <p className="text-xs text-muted">No approved chop-glyph assets yet — upload one in Assets.</p>;
  }
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-16 h-16 rounded border grid place-items-center text-2xs ${selectedId === null ? "border-accent" : "border-line"}`}
      >
        None
      </button>
      {approved.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onSelect(a.id)}
          className={`w-16 h-16 rounded border overflow-hidden ${selectedId === a.id ? "border-accent" : "border-line"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={assetFileUrl(a.id)} alt={a.variant} className="w-full h-full object-contain" />
        </button>
      ))}
    </div>
  );
}

export const labelComponent: ReleaseComponentDef = {
  key: "label",
  title: RELEASE_COMPONENT_TITLES.label,
  blurb: "Illustration, regulatory approval, print order.",
  status: (ctx) => labelComponentStatus(ctx.label),
  summary: (ctx) => {
    if (!ctx.label) return "Not started";
    const stages: [string, StageStatus][] = [
      ["Art", illustrationStatus(ctx.label.illustration)],
      ["Reg", regulatoryStatus(ctx.label.regulatory)],
      ["Print", printOrderStatus(ctx.label.print_order)],
    ];
    return stages
      .map(([name, s]) => `${name} ${s === "done" ? "✓" : s === "in_progress" ? "…" : "—"}`)
      .join(" · ");
  },
  Editor: LabelEditor,
};
