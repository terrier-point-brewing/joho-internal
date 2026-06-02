export type BatchStatus =
  | "planning"
  | "brewing"
  | "fermenting"
  | "conditioning"
  | "ready_to_package"
  | "archived";

export type AdjustmentType = "received" | "used" | "waste" | "inventory_count" | "batch_use";

export type TankType = "fermenter" | "brite" | "unitank" | "serving" | "brewhouse" | "cold_storage";

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

export interface Tank {
  id: string;
  name: string;
  type: TankType;
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
  tanks: Pick<Tank, "id" | "name" | "type">;
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
  tanks: Pick<Tank, "id" | "name" | "type">;
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
