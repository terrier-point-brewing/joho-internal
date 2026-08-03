// Public surface of the consolidated financials module. Consumers (e.g. the
// API route) should import from here rather than reaching into individual
// files.

export { buildFinancials } from "./buildFinancials";
export { toWireResponse } from "./wireResponse";
export type {
  StatementKind,
  Measure,
  Channel,
  BblCoverage,
  MappingSource,
  FinancialsRow,
  DataQualitySummary,
  KpiSummary,
  FinancialsResponse,
} from "./types";
