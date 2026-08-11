"use client";

/**
 * Maps a party's `worksheetComponent` key (`TaxPartyTemplate.worksheetComponent`,
 * served by `GET /api/tax/parties`) to the React module that renders its
 * editable worksheet. `TaxWorksheetShell` (party-agnostic chrome) looks the
 * component up here instead of switching on `filing_key` directly, so adding
 * a new party template only needs one new entry in `WORKSHEET_MODULES`.
 */
import type { ComponentType } from "react";
import NcDorSalesUseWorksheet from "./NcDorSalesUse/Worksheet";
import { getTotalDueCents as ncDorTotalDueCents } from "./NcDorSalesUse/fieldOwnership";
import NcDorBeerExciseWorksheet from "./NcDorBeerExcise/Worksheet";
import { getTotalDueCents as ncDorBeerExciseTotalDueCents } from "./NcDorBeerExcise/fieldOwnership";
import WakeCountyFoodBeverageWorksheet from "./WakeCountyFoodBeverage/Worksheet";
import { getTotalDueCents as wakeCountyFoodBeverageTotalDueCents } from "./WakeCountyFoodBeverage/fieldOwnership";
import WakeCountyBeerWineWorksheet from "./WakeCountyBeerWine/Worksheet";
import { getTotalDueCents as wakeCountyBeerWineTotalDueCents } from "./WakeCountyBeerWine/fieldOwnership";

export interface PartyWorksheetProps {
  fields: Record<string, number | string | null>;
  /** `worksheet.meta.computedAt`, if present — used to key/remount money inputs on a fresh recompute. */
  computedAt?: string;
  onFieldsChange: (nextFields: Record<string, number | string | null>) => void;
  /** True once the parent tax task is `completed` — every manual field renders display-only and edits must not be emitted. */
  readOnly?: boolean;
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
  nc_dor_beer_excise: {
    Worksheet: NcDorBeerExciseWorksheet,
    getTotalDueCents: ncDorBeerExciseTotalDueCents,
  },
  wake_county_food_beverage: {
    Worksheet: WakeCountyFoodBeverageWorksheet,
    getTotalDueCents: wakeCountyFoodBeverageTotalDueCents,
  },
  wake_county_beer_wine: {
    Worksheet: WakeCountyBeerWineWorksheet,
    getTotalDueCents: wakeCountyBeerWineTotalDueCents,
  },
};

export function getWorksheetModule(key: string): PartyWorksheetModule | undefined {
  return WORKSHEET_MODULES[key];
}
