import type { Slot } from "./slots";

/**
 * Constraint validation — run BEFORE a render, never after.
 *
 * A render that silently produces something wrong is worse than one that
 * refuses, because the wrongness is discovered downstream: on a proof, at a
 * print shop, or on a shelf. Every rule here is one that a renderer would
 * otherwise paper over — text that overflows its box, a color frozen to a
 * literal, a barcode that draws beautifully and does not scan.
 *
 * Messages are written for the person who has to fix the input, so they name
 * the slot by its label and say what to do, not what failed internally.
 */

export interface SlotIssue {
  slotKey: string;
  /** `error` blocks the render; `warning` does not. */
  severity: "error" | "warning";
  message: string;
}

/** Everything the validator needs that does not come from the inputs. */
export interface ValidationContext {
  /** Approved assets available to fill asset slots. */
  assets?: { id: string; kind: string; variant?: string; status?: string }[];
  /** Semantic role names a color slot may reference (canon roleMap keys). */
  roleNames?: string[];
  /** Palette keys a color slot may reference. */
  paletteKeys?: string[];
  /** The active season, if one is in force. */
  season?: {
    backgroundHex?: string | null;
    chopGlyphAssetId?: string | null;
    seasonLogoAssetId?: string | null;
  } | null;
}

/** GTIN digit counts, by symbology. */
const BARCODE_LENGTH: Record<string, number> = { "upc-a": 12, "ean-13": 13 };

/**
 * The GS1 check digit for a GTIN body (every digit except the check itself).
 *
 * Weight alternately 3 and 1 from the RIGHTMOST digit of the body, sum, then
 * take the difference to the next multiple of ten. Identical for GTIN-8/12/13/14
 * because the weighting is anchored to the right, not to a fixed length.
 */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when a full GTIN's trailing check digit is the one GS1 would compute. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || code.length < 2) return false;
  const body = code.slice(0, -1);
  return gtinCheckDigit(body) === Number(code[code.length - 1]);
}

/** A literal color, as opposed to a token reference. */
function looksLikeLiteralColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    /^#?[0-9a-f]{3}$/.test(v) ||
    /^#?[0-9a-f]{6}$/.test(v) ||
    v.startsWith("rgb(") ||
    v.startsWith("rgba(") ||
    v.startsWith("hsl(")
  );
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/**
 * Validate a set of slot inputs against a template's slot declarations.
 *
 * Returns every issue rather than the first: an author fixing a label wants the
 * whole list, not one round trip per problem.
 */
export function validateSlotInputs(
  slots: Slot[],
  inputs: Record<string, unknown>,
  context: ValidationContext = {},
): SlotIssue[] {
  const issues: SlotIssue[] = [];
  const add = (slotKey: string, severity: SlotIssue["severity"], message: string) =>
    issues.push({ slotKey, severity, message });

  const assetById = new Map((context.assets ?? []).map((a) => [a.id, a]));

  for (const slot of slots) {
    const value = inputs[slot.key];

    // A motif slot is filled from the season, not by the author, so its
    // "missing" case is a missing season rather than a missing input.
    if (slot.type === "motif") {
      const season = context.season;
      if (!season) {
        if (slot.required) {
          add(slot.key, "error", `${slot.label} comes from the active season, and no season is active.`);
        }
        continue;
      }
      const resolved =
        slot.resolves === "background"
          ? season.backgroundHex
          : slot.resolves === "chop-glyph"
            ? season.chopGlyphAssetId
            : season.seasonLogoAssetId;
      if (isBlank(resolved) && slot.required) {
        add(
          slot.key,
          "error",
          `${slot.label} needs the active season to define its ${slot.resolves.replace("-", " ")}.`,
        );
      }
      continue;
    }

    if (isBlank(value)) {
      if (slot.required) add(slot.key, "error", `${slot.label} is required.`);
      continue;
    }

    switch (slot.type) {
      case "text": {
        const text = String(value);
        if (slot.maxChars && text.length > slot.maxChars) {
          const over = text.length - slot.maxChars;
          if (slot.fit === "reject") {
            add(
              slot.key,
              "error",
              `${slot.label} is ${over} character${over === 1 ? "" : "s"} over the ${slot.maxChars}-character limit. This slot does not reflow — shorten the copy.`,
            );
          } else {
            // shrink/wrap can absorb it, but the result is off-spec typography
            // rather than a failure, so this is a warning the author can accept.
            add(
              slot.key,
              "warning",
              `${slot.label} is ${over} character${over === 1 ? "" : "s"} over ${slot.maxChars}; it will ${slot.fit === "shrink" ? "be set smaller" : "wrap onto more lines"}.`,
            );
          }
        }
        break;
      }

      case "color": {
        const ref = String(value).trim();
        if (looksLikeLiteralColor(ref)) {
          add(
            slot.key,
            "error",
            `${slot.label} must reference a brand token, not the literal "${ref}". A literal is frozen at render time and stops tracking the palette.`,
          );
          break;
        }
        const known = [...(context.roleNames ?? []), ...(context.paletteKeys ?? [])];
        if (known.length > 0 && !known.includes(ref)) {
          add(slot.key, "error", `${slot.label} references "${ref}", which is not a brand role or palette key.`);
        } else if (slot.allowed?.length && !slot.allowed.includes(ref)) {
          add(
            slot.key,
            "error",
            `${slot.label} may only be ${slot.allowed.join(", ")} — got "${ref}".`,
          );
        }
        break;
      }

      case "asset": {
        const asset = assetById.get(String(value));
        if (!asset) {
          add(slot.key, "error", `${slot.label} points at an asset that no longer exists.`);
          break;
        }
        if (asset.kind !== slot.kind) {
          add(
            slot.key,
            "error",
            `${slot.label} needs a ${slot.kind} asset; "${asset.id}" is a ${asset.kind}.`,
          );
        }
        if (slot.variant && asset.variant !== slot.variant) {
          add(slot.key, "error", `${slot.label} needs the "${slot.variant}" variant.`);
        }
        if (asset.status && asset.status !== "approved") {
          add(slot.key, "error", `${slot.label} uses an asset that is ${asset.status}, not approved.`);
        }
        break;
      }

      case "image": {
        const image = value as { aspect?: number; dpi?: number };
        if (slot.aspect && typeof image?.aspect === "number") {
          // 2% covers rounding in a crop tool without letting a visibly wrong
          // ratio through.
          const drift = Math.abs(image.aspect - slot.aspect) / slot.aspect;
          if (drift > 0.02) {
            add(
              slot.key,
              "warning",
              `${slot.label} is ${image.aspect.toFixed(2)}:1 but the slot is ${slot.aspect.toFixed(2)}:1 — it will be cropped.`,
            );
          }
        }
        if (slot.minDpi && typeof image?.dpi === "number" && image.dpi < slot.minDpi) {
          add(
            slot.key,
            "error",
            `${slot.label} is ${Math.round(image.dpi)} DPI; this slot needs at least ${slot.minDpi} DPI to print.`,
          );
        }
        break;
      }

      case "generated": {
        const code = String(value).trim();
        const expected = BARCODE_LENGTH[slot.symbology];
        if (!/^\d+$/.test(code)) {
          add(slot.key, "error", `${slot.label} must be digits only.`);
          break;
        }
        if (code.length !== expected) {
          add(
            slot.key,
            "error",
            `${slot.label} must be ${expected} digits for ${slot.symbology.toUpperCase()} — got ${code.length}.`,
          );
          break;
        }
        // The one failure nobody sees on screen. A wrong check digit renders a
        // perfectly clean symbol that no scanner will read.
        if (!isValidGtin(code)) {
          add(
            slot.key,
            "error",
            `${slot.label} has an invalid check digit — it would print a barcode that will not scan. Expected ${gtinCheckDigit(code.slice(0, -1))} as the last digit.`,
          );
        }
        break;
      }
    }
  }

  // Inputs with no matching slot are almost always a renamed slot key, which
  // otherwise shows up as "the value I typed vanished".
  const declared = new Set(slots.map((s) => s.key));
  for (const key of Object.keys(inputs)) {
    if (!declared.has(key) && !isBlank(inputs[key])) {
      add(key, "warning", `"${key}" is not a slot on this template and will be ignored.`);
    }
  }

  return issues;
}

/** Convenience: does this input set block a render? */
export function hasBlockingIssues(issues: SlotIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
