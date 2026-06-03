export type BatchStatus =
  | "planning"
  | "brewing"
  | "fermenting"
  | "conditioning"
  | "archived";

export type AdjustmentType = "received" | "used" | "waste" | "inventory_count" | "batch_use";

export type EquipmentType =
  | "fermenter" | "brite" | "brewhouse"
  | "cold_storage" | "kegging" | "canning" | "backlog";

// Types that have no capacity constraint and don't hold a single batch
export const UNCONSTRAINED_EQUIPMENT_TYPES: EquipmentType[] = ["kegging", "canning", "cold_storage", "backlog"];

// Map equipment type to the batch status it implies
export const EQUIPMENT_TYPE_TO_STATUS: Partial<Record<EquipmentType, BatchStatus>> = {
  brewhouse:    "brewing",
  fermenter:    "fermenting",
  brite:        "conditioning",
  kegging:      "conditioning",
  canning:      "conditioning",
  cold_storage: "archived",
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
  /** Joined from contract_brewing_partners */
  contract_brewing_partners?: { company_name: string } | null;
  /** Joined from suppliers */
  suppliers?: { company_name: string } | null;
  created_at: string;
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
  created_at: string;
}

export interface BatchTransfer {
  id: string;
  batch_id: string;
  from_tank_id: string | null;
  to_tank_id: string | null;
  volume_bbl: number;
  shrinkage_bbl: number;
  transfer_type: "transfer" | "kegging" | "canning";
  notes: string | null;
  kegging_detail: unknown | null;
  canning_detail: unknown | null;
  transferred_at: string;
  from_tank?: { id: string; name: string; type: EquipmentType } | null;
  to_tank?:   { id: string; name: string; type: EquipmentType } | null;
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
  created_at: string;
}

export interface BatchStatusHistory {
  id: string;
  batch_id: string;
  status: BatchStatus;
  note: string | null;
  changed_at: string;
}

export interface PlannedAllocation {
  id: string;
  batch_id: string;
  label: string;
  volume_bbl: number;
  notes: string | null;
  created_at: string;
}

export interface BrewBatch {
  id: string;
  beer_name: string;
  batch_number: string | null;
  planned_brew_date: string;
  expected_delivery_date: string | null;
  volume_bbl: number;
  turns: number;
  status: BatchStatus;
  notes: string | null;
  recipe_id: string | null;
  recipes: { beer_name: string; brewery: string | null; brew_time_weeks: number | null; expected_yield_bbl: number | null } | null;
  batch_status_history: BatchStatusHistory[];
  planned_allocations?: PlannedAllocation[];
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

export interface BatchWorkflowStep {
  id: string;
  batch_id: string;
  step_order: number;
  equipment_id: string;
  scheduled_date: string | null;
  completed_at: string | null;
  notes: string | null;
  equipment: Pick<Equipment, "id" | "name" | "type">;
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
