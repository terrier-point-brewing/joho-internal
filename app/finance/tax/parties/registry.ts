"use client";

/**
 * Maps a party's `worksheetComponent` key (`TaxPartyTemplate.worksheetComponent`,
 * served by `GET /api/tax/parties`) to the React module that renders its
 * editable worksheet. `TaxWorksheetShell` (party-agnostic chrome) looks the
 * component up here instead of switching on `party_key` directly, so adding
 * a new party template only needs one new entry in `WORKSHEET_MODULES`.
 */
import type { ComponentType } from "react";
import NcDorSalesUseWorksheet from "./NcDorSalesUse/Worksheet";
import { getTotalDueCents as ncDorTotalDueCents } from "./NcDorSalesUse/fieldOwnership";

export interface PartyWorksheetProps {
  fields: Record<string, number | string | null>;
  /** `worksheet.meta.computedAt`, if present — used to key/remount money inputs on a fresh recompute. */
  computedAt?: string;
  onFieldsChange: (nextFields: Record<string, number | string | null>) => void;
}

export interface PartyWorksheetModule {
  Worksheet: ComponentType<PartyWorksheetProps>;
  /** Reads the party's bottom-line total (cents) off its worksheet fields, for the shell's totals footer. `null` before anything's computed. */
  getTotalDueCents: (fields: Record<string, number | string | null>) => number | null;
}

const WORKSHEET_MODULES: Record<string, PartyWorksheetModule> = {
  nc_dor_sales_use: {
    Worksheet: NcDorSalesUseWorksheet,
    getTotalDueCents: ncDorTotalDueCents,
  },
};

export function getWorksheetModule(key: string): PartyWorksheetModule | undefined {
  return WORKSHEET_MODULES[key];
}
