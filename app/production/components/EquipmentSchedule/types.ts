import type { ScheduleEntry } from "../../hooks/queries";
import type { BrewBatch } from "../../types";

export type PackagingTrack = {
  conditioning: FlowItem;  // conditioning entry or ghost
  items: FlowItem[];       // kegging/canning in planned_start order, then ghosts
};

export type FlowItem =
  | { kind: "entry"; entry: ScheduleEntry; children: FlowItem[] }
  | { kind: "conversion"; toBatch: { id: string; beer_name: string; batch_number: string | null }; volumeBbl: number; children: FlowItem[] }
  | { kind: "ghost"; stage: string; label: string; isRequired: boolean; children: FlowItem[] }
  | { kind: "planned_conversion"; beerName: string; volumeBbl: number; children: FlowItem[] }
  | { kind: "packaging_group"; tracks: PackagingTrack[]; children: [] };
