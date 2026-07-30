"use client";

import type { BrandCanon, FontRole } from "@/lib/brand/canon.types";
import ListField from "./ListField";

type UseCase = NonNullable<BrandCanon["typeUseCases"]>[number];
type Medium = UseCase["medium"];

const MEDIA: Medium[] = ["screen", "print", "packaging", "signage"];
const FONT_ROLES: FontRole[] = ["display", "body", "wordmark", "script"];

/**
 * Typed editor for the type use cases — where each face is used, and how large.
 *
 * `size` stays free text on purpose: print and screen don't share units
 * ("32/38", "48pt", "1.5rem" are all legitimate). The guide parses what it can
 * and falls back to inherited sizing for anything it can't read, so an
 * unparseable value costs a specimen rather than the page.
 */
export default function TypeUseCaseField({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  return (
    <ListField<UseCase>
      label="Use cases"
      description="Where each face is used and at what size. Each row renders as a live specimen in the guide."
      addLabel="Add use case"
      items={draft.typeUseCases ?? []}
      onChange={(typeUseCases) => onChange({ ...draft, typeUseCases })}
      blank={() => ({
        id: crypto.randomUUID(),
        medium: "screen",
        element: "",
        fontRole: "display",
        weight: 400,
        size: "",
      })}
      renderItem={(row, update) => (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="inp-sm w-28 shrink-0"
              value={row.medium}
              onChange={(e) => update({ medium: e.target.value as Medium })}
              aria-label="Medium"
            >
              {MEDIA.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input
              className="inp-sm flex-1 min-w-40"
              value={row.element}
              onChange={(e) => update({ element: e.target.value })}
              aria-label="Element"
              placeholder="Page title"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              className="inp-sm w-28 shrink-0"
              value={row.fontRole}
              onChange={(e) => update({ fontRole: e.target.value as FontRole })}
              aria-label="Font role"
            >
              {FONT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              type="number"
              className="inp-sm w-20 shrink-0"
              value={row.weight}
              onChange={(e) => update({ weight: Number(e.target.value) })}
              aria-label="Weight"
            />
            <input
              className="inp-sm w-24 shrink-0"
              value={row.size}
              onChange={(e) => update({ size: e.target.value })}
              aria-label="Size"
              placeholder="32/38"
            />
            <input
              className="inp-sm w-24 shrink-0"
              value={row.tracking ?? ""}
              onChange={(e) => update({ tracking: e.target.value || undefined })}
              aria-label="Tracking"
              placeholder="+4%"
            />
            <input
              className="inp-sm flex-1 min-w-32"
              value={row.notes ?? ""}
              onChange={(e) => update({ notes: e.target.value || undefined })}
              aria-label="Notes"
              placeholder="Notes (optional)"
            />
          </div>
        </div>
      )}
    />
  );
}
