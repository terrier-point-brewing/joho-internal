import type { RoleName } from "@/lib/brand/canon.types";
import { getCanon } from "@/lib/brand/getCanon";
import ThemeToggle from "@/app/components/brand/ThemeToggle";

// Explicit literal classNames (not template-string interpolation) so
// Tailwind's content scanner picks up every bg-brand-<role> utility.
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

// Demo brand surface — proves the canon -> resolver -> runtime-injected
// --color-brand-*/--font-brand-* pipeline end to end. Consumes only
// brand-namespaced utilities; never mixes in ops (--color-*) tokens.
export default async function BrandPreviewPage() {
  const canon = await getCanon();

  return (
    <main className="brand-surface min-h-screen px-4 sm:px-6 py-4 sm:py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-brand-display text-3xl text-brand-high-contrast">
          {canon.brandName}
        </h1>
        <ThemeToggle />
      </div>

      <section className="mb-10">
        <h2 className="font-brand-body text-xs font-semibold uppercase tracking-wide text-brand-content-muted mb-3">
          Role palette
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {ROLE_SWATCHES.map(({ role, className }) => (
            <div key={role} className="flex flex-col gap-1.5">
              <div
                className={`h-16 rounded-lg border border-brand-line ${className}`}
              />
              <span className="text-xs font-brand-body text-brand-content">
                {role}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10 max-w-2xl">
        <h2 className="font-brand-display text-2xl text-brand-high-contrast mb-2">
          {canon.mission}
        </h2>
        <p className="font-brand-body text-brand-content leading-relaxed">
          {canon.voice.summary}
        </p>
      </section>

      <section>
        <span className="font-brand-wordmark text-2xl tracking-wide text-brand-primary">
          {canon.brandName}
        </span>
      </section>
    </main>
  );
}
