import { createClient } from "@supabase/supabase-js";
import type { FontRole, RoleName } from "@/lib/brand/canon.types";
import { getCanon } from "@/lib/brand/getCanon";
import { resolveAsset, type SupabaseLikeClient } from "@/lib/brand/assets";
import { resolveApprovedLabels, type SupabaseLikeClient as LabelsClient } from "@/lib/brand/labels";
import ThemeToggle from "@/app/components/brand/ThemeToggle";
import ColorSwatch from "./ColorSwatch";

// Cookieless anon client for reading the approved wordmark asset — same
// approach as lib/brand/getCanon.ts's createCookielessClient (not exported
// there, so duplicated here): approved assets are readable by anon (RLS
// allows SELECT where status='approved'), so this touches no cookies()/
// headers() and keeps the page statically renderable when possible.
function createCookielessAssetClient(): SupabaseLikeClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client as unknown as SupabaseLikeClient;
}

// Explicit literal classNames (not template-string interpolation) so
// Tailwind's content scanner picks up every bg-brand-<role> utility. Order
// here is display order in the "Role palette" section.
const ROLE_SWATCHES: { role: RoleName; className: string }[] = [
  { role: "canvas", className: "bg-brand-canvas" },
  { role: "surface", className: "bg-brand-surface" },
  { role: "surface-raised", className: "bg-brand-surface-raised" },
  { role: "primary", className: "bg-brand-primary" },
  { role: "on-primary", className: "bg-brand-on-primary" },
  { role: "secondary", className: "bg-brand-secondary" },
  { role: "accent", className: "bg-brand-accent" },
  { role: "on-accent", className: "bg-brand-on-accent" },
  { role: "high-contrast", className: "bg-brand-high-contrast" },
  { role: "content", className: "bg-brand-content" },
  { role: "content-muted", className: "bg-brand-content-muted" },
  { role: "line", className: "bg-brand-line" },
  { role: "line-strong", className: "bg-brand-line-strong" },
];

const FONT_CLASS: Record<FontRole, string> = {
  display: "font-brand-display",
  body: "font-brand-body",
  wordmark: "font-brand-wordmark",
  script: "font-brand-script",
};

// Data-driven brand guide — renders the published canon (or seed fallback)
// as a full-page Joho light/dark surface. Server component; the only client
// leaf is ColorSwatch (click-to-copy needs onClick).
export default async function BrandGuidePage() {
  const canon = await getCanon();
  const assetClient = createCookielessAssetClient();
  const wordmarkUrl = assetClient ? await resolveAsset(assetClient, { kind: "wordmark" }) : null;
  const labels = assetClient
    ? await resolveApprovedLabels(assetClient as unknown as LabelsClient)
    : [];

  const paletteByKey = new Map(canon.palette.map((c) => [c.key, c]));
  const ratioByRole = new Map(canon.usageRatios.map((r) => [r.role, r]));

  return (
    <div className="brand-surface -mx-4 sm:-mx-6 -my-4 sm:-my-8 px-4 sm:px-6 py-4 sm:py-8">
      {/* Hero */}
      <div className="flex items-start justify-between gap-4 mb-10">
        <div>
          {wordmarkUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- approved brand asset from Storage, not a static import
            <img src={wordmarkUrl} alt={canon.brandName} className="h-9 w-auto" />
          ) : (
            <span className="font-brand-wordmark text-3xl tracking-wide text-brand-primary">
              {canon.brandName}
            </span>
          )}
          <p className="font-brand-body text-xs text-brand-content-muted mt-1">
            Brand guide · v{canon.version}
          </p>
        </div>
        <ThemeToggle />
      </div>

      <section className="mb-12 max-w-2xl">
        <h1 className="font-brand-display text-2xl text-brand-high-contrast mb-3">
          {canon.mission}
        </h1>
        {canon.missionNarrative && (
          <p className="font-brand-body text-brand-content leading-relaxed">
            {canon.missionNarrative}
          </p>
        )}
      </section>

      {/* Values & their costs */}
      {canon.values?.length > 0 && (
        <section className="mb-12 max-w-3xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            Values &amp; their costs
          </h2>
          <div className="flex flex-col gap-3">
            {canon.values.map((v) => (
              <div key={v.n} className="rounded-lg border border-brand-line p-4">
                <p className="font-brand-display text-lg text-brand-high-contrast">
                  {v.n}. {v.title}
                </p>
                <p className="font-brand-body text-sm text-brand-content mt-1">{v.means}</p>
                <p className="font-brand-body text-xs text-brand-content-muted mt-2">
                  <span className="text-brand-accent uppercase tracking-wide">The cost · </span>
                  {v.cost}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* The Never List */}
      {canon.neverList?.length > 0 && (
        <section className="mb-12 max-w-2xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            The Never List
          </h2>
          <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1">
            {canon.neverList.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Voice */}
      <section className="mb-12">
        <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
          Voice
        </h2>
        <p className="font-brand-body text-brand-content leading-relaxed max-w-2xl mb-2">
          {canon.voice.summary}
        </p>
        {canon.voice.personality && (
          <p className="font-brand-body text-sm text-brand-content-muted leading-relaxed max-w-2xl mb-4">
            {canon.voice.personality}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 max-w-2xl mb-4">
          {canon.voice.sliders.map((slider, i) => (
            <div key={i} className="rounded-lg border border-brand-line p-3 font-brand-body">
              <div className="flex items-center justify-between text-xs text-brand-content-muted mb-2">
                <span>{slider.left}</span>
                <span>{slider.right}</span>
              </div>
              <div className="relative h-1 rounded bg-brand-line mb-2">
                <span
                  className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-accent"
                  style={{ left: `${slider.pos}%` }}
                />
              </div>
              <p className="text-xs text-brand-content-muted">{slider.note}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 font-brand-body text-xs mb-4">
          <div>
            <span className="text-brand-content-muted uppercase tracking-wide">Lean on: </span>
            <span className="text-brand-content">{canon.voice.leanOnWords.join(", ")}</span>
          </div>
          <div>
            <span className="text-brand-accent uppercase tracking-wide">Never: </span>
            <span className="text-brand-content">{canon.voice.neverWords.join(", ")}</span>
          </div>
        </div>
        {canon.voice.rewrites?.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
            {canon.voice.rewrites.map((rw, i) => (
              <div key={i} className="rounded-lg border border-brand-line p-3 font-brand-body">
                <p className="text-2xs uppercase tracking-wide text-brand-content-muted mb-1">
                  {rw.context}
                </p>
                <p className="text-sm text-brand-content">
                  <span className="text-brand-primary">✓ </span>
                  {rw.on}
                </p>
                <p className="text-xs text-brand-content-muted mt-1">
                  <span className="text-brand-accent">✕ </span>
                  {rw.off}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Color palette */}
      <section className="mb-12">
        <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
          Role palette
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {ROLE_SWATCHES.map(({ role, className }) => {
            const key = canon.roleMap.light[role];
            const color = paletteByKey.get(key);
            // Same resolution as lib/brand/tokens.ts's resolveLight: the role
            // value is either a palette key (resolve to its hex) or itself a
            // raw hex.
            const hex = color?.hex ?? key;
            const ratio = ratioByRole.get(role);
            return (
              <ColorSwatch
                key={role}
                label={role}
                swatchName={color?.name ?? key}
                hex={hex}
                swatchClassName={className}
                pct={ratio?.pct}
              />
            );
          })}
        </div>
        {canon.colorForbidden?.length > 0 && (
          <div className="mt-4 max-w-2xl">
            <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-accent mb-1">
              Forbidden
            </p>
            <ul className="font-brand-body text-xs text-brand-content-muted space-y-0.5">
              {canon.colorForbidden.map((f, i) => (
                <li key={i}>✕ {f}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Type specimen */}
      <section className="mb-12">
        <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
          Type
        </h2>
        <div className="flex flex-col gap-4">
          {canon.fonts.map((font) => (
            <div key={font.role} className="border-b border-brand-line pb-4">
              <p className="font-brand-body text-xs text-brand-content-muted mb-1">
                {font.role} · {font.family} · weights {font.weights.join(", ")}
                {font.note ? ` · ${font.note}` : ""}
              </p>
              <p className={`${FONT_CLASS[font.role]} text-3xl text-brand-high-contrast`}>
                {canon.brandName} — The quick brown fox
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Naming */}
      <section className="mb-12 max-w-2xl">
        <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
          Naming
        </h2>
        <p className="font-brand-display text-lg text-brand-high-contrast mb-3">
          {canon.naming.pattern}
        </p>
        <ol className="list-decimal list-inside font-brand-body text-sm text-brand-content space-y-1 mb-4">
          {canon.naming.criteria.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ol>
        {canon.naming.passingExamples && canon.naming.passingExamples.length > 0 && (
          <div className="flex flex-col gap-2">
            {canon.naming.passingExamples.map((ex) => (
              <div key={ex.name} className="rounded-lg border border-brand-line p-3">
                <p className="font-brand-display text-brand-high-contrast">{ex.name}</p>
                <p className="font-brand-body text-xs text-brand-content-muted mt-1">{ex.why}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* The chop */}
      {canon.chop?.specs?.length > 0 && (
        <section className="mb-12 max-w-3xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            The chop (seal)
          </h2>
          <p className="font-brand-body text-brand-content leading-relaxed mb-4">{canon.chop.narrative}</p>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 font-brand-body text-sm">
            {canon.chop.specs.map((s, i) => (
              <div key={i}>
                <dt className="text-brand-content-muted text-xs uppercase tracking-wide">{s.key}</dt>
                <dd className="text-brand-content">{s.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* Label chassis */}
      {canon.labelChassis?.elements?.length > 0 && (
        <section className="mb-12 max-w-3xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            Label chassis
          </h2>
          <p className="font-brand-body text-brand-content leading-relaxed mb-4">
            {canon.labelChassis.narrative}
          </p>
          <ol className="flex flex-col gap-2">
            {canon.labelChassis.elements.map((el) => (
              <li key={el.n} className="rounded-lg border border-brand-line p-3 font-brand-body">
                <p className="text-sm text-brand-high-contrast">
                  {el.n} · {el.title}
                </p>
                <p className="text-xs text-brand-content-muted mt-0.5">{el.desc}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Illustration law */}
      {canon.illustrationLaw?.rules?.length > 0 && (
        <section className="mb-12 max-w-3xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            Illustration law
          </h2>
          <p className="font-brand-body text-brand-content leading-relaxed mb-4">
            {canon.illustrationLaw.narrative}
          </p>
          <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1">
            {canon.illustrationLaw.rules.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {/* Tap list — approved labels */}
      {labels.length > 0 && (
        <section className="mb-12 max-w-4xl">
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-4">
            Tap list
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {labels.map((label) => (
              <div key={label.id} className="rounded-lg border border-brand-line p-4">
                <p className="font-brand-display text-lg text-brand-high-contrast">{label.name}</p>
                {label.subtitle && (
                  <p className="font-brand-body text-sm text-brand-content mt-0.5">{label.subtitle}</p>
                )}
                {label.motif_family && (
                  <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted mt-2">
                    {label.motif_family}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Precedence + agent rules */}
      <section className="grid gap-8 sm:grid-cols-2 max-w-4xl">
        <div>
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            Precedence
          </h2>
          <ol className="list-decimal list-inside font-brand-body text-sm text-brand-content space-y-1">
            {canon.precedence.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
        </div>
        <div>
          <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
            Hard rules
          </h2>
          <ul className="list-disc list-inside font-brand-body text-sm text-brand-content space-y-1">
            {(canon.hardRules ?? []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
