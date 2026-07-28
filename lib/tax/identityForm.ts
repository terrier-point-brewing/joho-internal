/**
 * Pure form-state helpers for the Tax Filing settings identity form
 * (app/settings/tax/filing/IdentityForm.tsx). Kept out of the
 * component so the write-only sensitive-field contract — a masked GET never
 * seeds a real value into the form, and a blank submit means "leave
 * unchanged" — is unit-testable without React.
 */
import type { FieldSpec } from "./types";

/**
 * Seeds form state from a party's `settingsSchema` and the MASKED values
 * `GET /api/tax/profiles/[party]` returns. Sensitive fields (`field.sensitive`)
 * are always blanked regardless of their masked status ("present"/"absent")
 * — the form must never display or imply a stored sensitive value, only
 * whether one exists (see `isSensitivePresent`). Non-sensitive fields are
 * prefilled from the masked payload (which passes them through unchanged).
 */
export function initialFormValues(schema: FieldSpec[], masked: Record<string, string> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of schema) {
    values[field.key] = field.sensitive ? "" : (masked?.[field.key] ?? "");
  }
  return values;
}

/**
 * Whether a sensitive field currently has a stored value, per the masked
 * GET payload ("present" vs "absent"/missing). Non-sensitive fields have no
 * such status and always report `false`.
 */
export function isSensitivePresent(field: FieldSpec, masked: Record<string, string> | undefined): boolean {
  return !!field.sensitive && masked?.[field.key] === "present";
}

/**
 * Builds the `PUT /api/tax/profiles/[party]` body from current form state,
 * restricted to the party's schema keys (defensive against stray form state)
 * and trimmed. A blank value for ANY field — sensitive or not — is left as
 * `""` here; the server's `putProfile` already treats `""`/nullish as "leave
 * the stored value unchanged" (lib/tax/profiles.ts), which is exactly the
 * write-only contract this form relies on for sensitive fields.
 */
export function buildPutPayload(schema: FieldSpec[], values: Record<string, string>): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of schema) {
    payload[field.key] = (values[field.key] ?? "").trim();
  }
  return payload;
}
