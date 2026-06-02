export type BatchStatus =
  | "planning"
  | "brewing"
  | "fermenting"
  | "conditioning"
  | "ready_to_package"
  | "archived";

export type AdjustmentType = "received" | "used" | "waste" | "inventory_count" | "batch_use";

export type EquipmentType =
  | "fermenter" | "brite" | "brewhouse"
  | "cold_storage" | "kegging" | "canning";

// Types that have no capacity constraint and don't hold a single batch
export const UNCONSTRAINED_EQUIPMENT_TYPES: EquipmentType[] = ["kegging", "canning", "cold_storage"];

// Map equipment type to the batch status it implies
export const EQUIPMENT_TYPE_TO_STATUS: Partial<Record<EquipmentType, BatchStatus>> = {
  brewhouse:    "brewing",
  fermenter:    "fermenting",
  brite:        "conditioning",
  kegging:      "ready_to_package",
  canning:      "ready_to_package",
  cold_storage: "archived",
};

export type PackagingItemType = "keg" | "can" | "lid" | "paktech" | "tray";

export interface PackagingItem {
  id: string;
  type: PackagingItemType;
  name: string;
  supplier: string | null;
  unit_cost: number | null;
  brewery: string | null;
  volume_fl_oz: number | null;
  can_count: number | null;
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

export interface Ingredient {
  id: string;
  name: string;
  supplier: string | null;
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

export interface BrewBatch {
  id: string;
  beer_name: string;
  batch_number: string | null;
  planned_brew_date: string;
  volume_bbl: number;
  turns: number;
  status: BatchStatus;
  notes: string | null;
  recipe_id: string | null;
  recipes: { beer_name: string; brewery: string | null } | null;
  batch_status_history: BatchStatusHistory[];
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
