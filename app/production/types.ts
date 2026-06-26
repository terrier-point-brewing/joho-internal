export type BatchStatus =
  | "planning"
  | "brewing"
  | "fermenting"
  | "conditioning"
  | "packaging"
  | "complete";

export type AdjustmentType = "received" | "used" | "waste" | "inventory_count" | "batch_use";

export type EquipmentType =
  | "fermenter" | "brite" | "brewhouse"
  | "cold_storage" | "kegging" | "canning" | "backlog"
  | "loading_bay" | "export_bay";

// Types that have no capacity constraint and don't hold a single batch
export const UNCONSTRAINED_EQUIPMENT_TYPES: EquipmentType[] = ["kegging", "canning", "cold_storage", "backlog", "loading_bay", "export_bay"];

// Map equipment type to the batch status it implies. cold_storage has no
// entry — arrival in cold storage no longer changes batch status; only a
// full export (see lib/production/batchCompletion.ts) transitions to "complete".
export const EQUIPMENT_TYPE_TO_STATUS: Partial<Record<EquipmentType, BatchStatus>> = {
  brewhouse:    "brewing",
  fermenter:    "fermenting",
  brite:        "conditioning",
  kegging:      "packaging",
  canning:      "packaging",
};

export type PackagingItemType = "keg" | "can" | "lid" | "paktech" | "tray" | "label";

export interface PackagingItem {
  id: string;
  type: PackagingItemType;
  name: string;
  is_default: boolean;
  stock_quantity: number;
  unit_cost: number | null;
  volume_fl_oz: number | null;
  can_count: number | null;
  partner_id: string | null;
  supplier_id: string | null;
  requires_label: boolean;
  /** Joined from contract_brewing_partners */
  contract_brewing_partners?: { company_name: string } | null;
  /** Joined from suppliers */
  suppliers?: { company_name: string } | null;
  created_at: string;
}

export type PackagingVariationFormat = "loose" | "4-pack" | "6-pack" | "case";

export interface PackagingVariation {
  id: string;
  container_id: string;
  format: PackagingVariationFormat;
  lid_id: string | null;
  paktech_id: string | null;
  tray_id: string | null;
  label_id: string | null;
  partner_id: string | null;
  name: string;
  total_volume_fl_oz: number;
  is_active: boolean;
  created_at: string;
  /** Joined */
  container?: { id: string; name: string; type: PackagingItemType; volume_fl_oz: number | null } | null;
  lid?: { id: string; name: string } | null;
  paktech?: { id: string; name: string } | null;
  tray?: { id: string; name: string } | null;
  label?: { id: string; name: string } | null;
  contract_brewing_partners?: { company_name: string } | null;
}

export interface RecipePackagingVariation {
  id: string;
  recipe_id: string;
  variation_id: string;
  created_at: string;
  /** Joined */
  packaging_variations?: PackagingVariation | null;
}

export type PackagingAdjustmentType = "received" | "used" | "waste" | "inventory_count";

export interface PackagingStockAdjustment {
  id: string;
  packaging_item_id: string;
  quantity: number;
  type: PackagingAdjustmentType;
  note: string | null;
  cost_per_unit: number | null;
  total_value_change: number | null;
  shipping_cost: number | null;
  /** FK to the batch_transfer that triggered a "used" deduction, if any. */
  batch_transfer_id: string | null;
  created_at: string;
  packaging_items?: { name: string; type: PackagingItemType };
}

export type BrewAdjustmentType = "sold" | "distributed" | "waste" | "inventory_count";

export interface BrewInventoryAdjustment {
  id: string;
  batch_transfer_id: string;
  quantity: number;
  type: BrewAdjustmentType;
  note: string | null;
  /** Packaging format label, e.g. "1/6 BBL" or "can" */
  product_label: string | null;
  /** "keg" or "can" */
  product_type: string | null;
  /** Unit of quantity, e.g. "kegs" or "cans" */
  unit: string | null;
  created_at: string;
}

export interface BatchTransfer {
  id: string;
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: "transfer" | "kegging" | "canning" | "export" | "conversion" | "brewing";
  notes: string | null;
  variation_id: string | null;
  quantity: number | null;
  packaging_variations?: { id: string; name: string } | null;
  export_detail: {
    items: { source_transfer_id: string; product_label: string; product_type: "keg" | "can"; quantity: number }[];
  } | null;
  transferred_at: string;
  to_batch_id: string | null;
  from_tank?: { id: string; name: string; type: EquipmentType } | null;
  to_tank?:   { id: string; name: string; type: EquipmentType } | null;
  to_batch?:  { id: string; beer_name: string; batch_number: string | null } | null;
  created_by_profile?: { email: string } | null;
}

/** One row per recipe + packaging variant, summed across every batch — the Export Bay's "Available" column. */
export interface AvailableInventoryLine {
  recipe_id: string;
  variation_id: string;
  variation_name: string;
  quantity_on_hand: number;
}

export interface ColdStorageInventory {
  id: string;
  batch_id: string;
  recipe_id: string | null;
  variation_id: string;
  quantity_on_hand: number;
  source_transfer_id: string | null;
  created_at: string;
  updated_at: string;
}

export type ExportChannel = "taproom" | "distribution" | "contract_brewing";
export type ExportTransactionStatus = "invoice_required" | "unpaid" | "paid";

export interface ExportTransaction {
  id: string;
  shipment_id: string;
  batch_id: string;
  recipe_id: string | null;
  allocation_id: string | null;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  status: ExportTransactionStatus;
  total_excise_tax_usd: number;
  source_transfer_id: string | null;
  notes: string | null;
  created_at: string;
  brew_batches?: { id: string; beer_name: string; batch_number: string | null } | null;
}

export interface ExportTransactionTax {
  id: string;
  export_transaction_id: string;
  excise_tax_rate_id: string | null;
  tax_name: string;
  unit: "bbl" | "gallon";
  rate_usd: number;
  amount_usd: number;
  created_at: string;
}

export type IngredientCategory = "Malts" | "Hops" | "Yeast" | "Brewing Aids" | "Fruit" | "Abstrax";

export const INGREDIENT_CATEGORIES: IngredientCategory[] = [
  "Malts", "Hops", "Yeast", "Brewing Aids", "Fruit", "Abstrax",
];

export interface Ingredient {
  id: string;
  name: string;
  category: IngredientCategory | null;
  supplier_id: string | null;
  partner_id: string | null;
  /** Joined from suppliers */
  suppliers?: { company_name: string } | null;
  /** Joined from contract_brewing_partners */
  contract_brewing_partners?: { company_name: string } | null;
  unit: string;
  cost_per_unit: number | null;
  stock_quantity: number;
  alpha_acid: number | null;
  color_lovibond: number | null;
  created_at: string;
}

export interface StockAdjustment {
  id: string;
  ingredient_id: string;
  quantity: number;
  type: AdjustmentType;
  note: string | null;
  batch_id: string | null;
  cost_per_unit: number | null;
  total_value_change: number | null;
  shipping_cost: number | null;
  /** Snapshot of the ingredient's unit at the time of the adjustment (e.g. "lbs", "oz"). */
  unit: string | null;
  created_at: string;
  ingredients?: { name: string; unit: string };
  brew_batches?: { beer_name: string; batch_number: string | null } | null;
}

export interface RecipeIngredientRow {
  id: string;
  recipe_id: string;
  ingredient_id: string;
  quantity_per_bbl: number;
  ingredients: Ingredient;
}

export interface RecipeBrewActivityTemplate {
  id: string;
  recipe_id: string;
  sort_order: number;
  activity: string;
  time_label: string | null;
  temp: number | null;
  /** Unit for temp — "F" (Fahrenheit) or "C" (Celsius). Defaults to "F". */
  temp_unit: string;
  amount: number | null;
  /** Unit for amount — e.g. "lbs", "oz", "gal". */
  amount_unit: string | null;
  vsp: number | null;
  created_at: string;
}

export interface Recipe {
  id: string;
  beer_name: string;
  brewery: string | null;
  expected_yield_bbl: number | null;
  brew_time_weeks: number | null;
  days_brewhouse: number | null;
  days_fermenter: number | null;
  days_brite: number | null;
  steps: string | null;
  notes: string | null;
  recipe_ingredients: RecipeIngredientRow[];
  recipe_brew_activity_templates: RecipeBrewActivityTemplate[];
  created_at: string;
}

/** Lead time of a style = total time it occupies brewing equipment, in days. */
export function leadTimeDays(recipe: Pick<Recipe, "days_brewhouse" | "days_fermenter" | "days_brite">): number {
  return (recipe.days_brewhouse ?? 0) + (recipe.days_fermenter ?? 0) + (recipe.days_brite ?? 0);
}

export type Packaging = "draft" | "keg" | "can";

export interface RecipeSquareLink {
  id: string;
  recipe_id: string;
  packaging: Packaging;
  square_variation_id: string;
  square_item_id: string | null;
  created_at: string;
}

export type AllocationCadence = "one_time" | "recurring";
export type AllocationRecurrence = "weekly" | "biweekly" | "monthly";

export type AllocationStatus = "active" | "paused" | "fulfilled" | "cancelled";

export type ContractRequestStatus = "open" | "in_progress" | "fulfilled" | "cancelled";
export type CommitmentChannel = "distribution" | "contract_brewing";

export interface CommitmentPackagingPreference {
  id: string;
  commitment_id: string;
  packaging_item_id: string;
  qty: number;
  created_at: string;
  packaging_items?: { id: string; name: string; volume_fl_oz: number | null } | null;
}

/** Slice of a batch_allocation surfaced on the Commitments view for invoicing. */
export interface CommitmentAllocationSummary {
  id: string;
  batch_id: string;
  percentage: number;
  locked: boolean;
  lock_reason: AllocationLockReason | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
  brew_batches?: { id: string; beer_name: string; batch_number: number; volume_bbl: number } | null;
  contract_brewing_partners?: { id: string; company_name: string } | null;
}

export interface Commitment {
  id: string;
  recipe_id: string | null;
  beer_style: string;
  partner_id: string | null;
  volume_bbl: number;
  desired_delivery_date: string | null;
  status: ContractRequestStatus;
  notes: string | null;
  channel: CommitmentChannel;
  cadence: "one_time" | "recurring";
  recurrence: "weekly" | "biweekly" | "monthly" | null;
  start_date: string | null;
  end_date: string | null;
  received_on: string | null;
  last_edited_on: string | null;
  locked_on: string | null;
  created_at: string;
  recipes?: { beer_name: string } | null;
  contract_brewing_partners?: { company_name: string } | null;
  packaging_preferences?: CommitmentPackagingPreference[];
  /** Sum of (batch volume x allocated %) across all allocations referencing this commitment. */
  committed_allocated_bbl?: number;
  /** Linked batch_allocations (channel=contract_brewing) for inline invoicing controls. */
  batch_allocations?: CommitmentAllocationSummary[];
}

/** @deprecated Use Commitment instead */
export type ContractBrewingRequest = Commitment;

export interface SafetyStockFloor {
  id: string;
  recipe_id: string;
  packaging: "keg" | "can";
  floor_quantity: number;
  created_at: string;
}

export interface BatchStatusHistory {
  id: string;
  batch_id: string;
  status: BatchStatus;
  note: string | null;
  changed_at: string;
}


export type AllocationChannel = "taproom" | "distribution" | "contract_brewing" | "safety_stock" | "conversion";
export type AllocationLockReason = "deposit_paid" | "contract_signed";

export interface BatchAllocation {
  id: string;
  batch_id: string;
  channel: AllocationChannel;
  contract_request_id: string | null;
  partner_id: string | null;
  label: string | null;
  percentage: number;
  locked: boolean;
  lock_reason: AllocationLockReason | null;
  locked_at: string | null;
  notes: string | null;
  created_at: string;
  /** For channel="conversion": which recipe this slice is earmarked to convert into. */
  conversion_target_recipe_id: string | null;
  // ── Deposit invoice tracking ─────────────────────────────────────────────
  square_deposit_invoice_id: string | null;
  square_deposit_order_id: string | null;
  invoice_generated_at: string | null;
  invoice_sent_at: string | null;
  invoice_paid_at: string | null;
  // ── Refund tracking ──────────────────────────────────────────────────────
  square_payment_id: string | null;
  deposit_amount_paid_cents: number | null;
  square_refund_id: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
  // ── Joined fields ────────────────────────────────────────────────────────
  brew_batches?: { id: string; beer_name: string; batch_number: number; volume_bbl: number; recipe_id: string | null } | null;
  contract_brewing_partners?: { id: string; company_name: string } | null;
  commitments?: { id: string; beer_style: string; volume_bbl: number; received_on: string | null; created_at: string; desired_delivery_date: string | null } | null;
  conversion_target_recipe?: { id: string; beer_name: string } | null;
  // Computed fulfillment fields (returned by API)
  produced_bbl: number | null;
  allocated_bbl: number | null;
  exported_bbl: number;
  fulfilled: boolean;
}

export interface BrewActivityEntry {
  id: string;
  batch_id?: string;
  recipe_id?: string;
  template_id?: string | null;
  sort_order: number;
  activity: string;
  time_label: string | null;
  temp: number | null;
  /** Unit for temp — "F" (Fahrenheit) or "C" (Celsius). Defaults to "F". */
  temp_unit: string;
  amount: number | null;
  /** Unit for amount — e.g. "lbs", "oz", "gal". */
  amount_unit: string | null;
  vsp: number | null;
  created_at: string;
}

export interface BrewBatch {
  id: string;
  beer_name: string;
  converted_from_batch_id: string | null;
  converted_volume_bbl: number | null;
  converted_from_batch?: { id: string; beer_name: string; batch_number: string | null } | null;
  batch_number: string | null;
  planned_brew_date: string;
  expected_delivery_date: string | null;
  volume_bbl: number;
  turns: number;
  /** How many brewhouse turns have been started (and had ingredients deducted). */
  turns_completed: number;
  status: BatchStatus;
  notes: string | null;
  ibu: number | null;
  /** Beer color in Standard Reference Method (SRM) units. */
  color_srm: number | null;
  original_gravity: number | null;
  final_gravity: number | null;
  /** Dissolved oxygen in parts per billion (ppb). */
  dissolved_oxygen_ppb: number | null;
  square_invoice_id: string | null;
  recipe_id: string | null;
  recipes: { beer_name: string; brewery: string | null; brew_time_weeks: number | null; expected_yield_bbl: number | null } | null;
  batch_status_history: BatchStatusHistory[];
  batch_brew_activity_log?: BrewActivityEntry[];
  created_at: string;
}

export interface ContractBrewingPartner {
  id: string;
  company_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
  notes: string | null;
  square_customer_id: string | null;
  export_net_terms_days: number | null;
  created_at: string;
}

export interface Supplier {
  id: string;
  company_name: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  address: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
}

export interface Equipment {
  id: string;
  name: string;
  type: EquipmentType;
  capacity_bbl: number | null;
  notes: string | null;
  grid_row: number | null;
  grid_col: number | null;
  grid_width: number;
  grid_height: number;
  created_at: string;
}

export interface WorkflowTemplateStep {
  id: string;
  template_id: string;
  step_order: number;
  equipment_id: string;
  duration_days: number | null;
  notes: string | null;
  equipment: Pick<Equipment, "id" | "name" | "type">;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  workflow_template_steps: WorkflowTemplateStep[];
  created_at: string;
}


export interface BatchTankAssignment {
  id: string;
  batch_id: string;
  tank_id: string;
  assigned_at: string;
  released_at: string | null;
  notes: string | null;
  brew_batches?: Pick<BrewBatch, "id" | "beer_name" | "batch_number" | "status" | "volume_bbl">;
}

export type ServiceType = "packaging_fee" | "keg_cleaning" | "forklift" | "bulk_discount";

export interface ExciseTaxRate {
  id: string;
  name: string;
  receiving_party: string | null;
  unit: "bbl" | "gallon";
  rate_usd: number;
  is_active: boolean;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportServiceMapping {
  id: string;
  service_type: ServiceType;
  partner_id: string | null;
  packaging_item_id: string | null;
  square_catalog_item_id: string | null;
  square_catalog_variation_id: string | null;
  square_catalog_discount_id: string | null;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface SquareCatalogOptions {
  items: { itemId: string; itemName: string; variations: { variationId: string; variationName: string }[] }[];
  discounts: { id: string; name: string }[];
}
