// Shared filing-identity schema: the generic contact/account fields every
// receiving party (NC DOR, IRS, etc.) needs, regardless of the party's own
// tax-specific settings. Party templates that need identity fields spread
// `IDENTITY_SCHEMA` into their own `settingsSchema` rather than redeclaring
// contact_name/contact_email/contact_phone/account_id/fein/ssn per party.
import type { FieldSpec } from "./types";
import { US_STATES } from "./usStates";

export const IDENTITY_SCHEMA: FieldSpec[] = [
  { key: "contact_name", label: "Contact name", type: "text" },
  { key: "contact_email", label: "Contact email", type: "email" },
  { key: "contact_phone", label: "Contact phone", type: "tel" },
  { key: "legal_name", label: "Legal name", type: "text" },
  { key: "trade_name", label: "Trade name (DBA)", type: "text" },
  { key: "mailing_address", label: "Mailing address", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "select", options: US_STATES },
  { key: "zip", label: "ZIP", type: "text" },
  {
    key: "account_id",
    label: "Filing account ID",
    type: "text",
    help: "The account number this receiving party issued for the filer.",
  },
  { key: "fein", label: "Federal EIN", type: "text", required: true },
  { key: "ssn", label: "SSN (only if no FEIN)", type: "text", sensitive: true },
];
