import { EquipmentType } from "./types";

export const EQ: Record<EquipmentType, {
  label: string;
  headerBg: string;
  border: string;
  badge: string;
  defaultW: number;
  defaultH: number;
}> = {
  fermenter:    { label: "Fermenter",    headerBg: "bg-blue-950/80",   border: "border-blue-800",   badge: "bg-blue-900/60 text-blue-300 border-blue-700",      defaultW: 2, defaultH: 4 },
  brite:        { label: "Brite",        headerBg: "bg-cyan-950/80",   border: "border-cyan-800",   badge: "bg-cyan-900/60 text-cyan-300 border-cyan-700",      defaultW: 2, defaultH: 3 },
  brewhouse:    { label: "Brewhouse",    headerBg: "bg-amber-950/80",  border: "border-amber-700",  badge: "bg-amber-900/60 text-amber-300 border-amber-600",   defaultW: 3, defaultH: 3 },
  cold_storage: { label: "Cold Storage", headerBg: "bg-sky-950/80",    border: "border-sky-800",    badge: "bg-sky-900/60 text-sky-300 border-sky-700",         defaultW: 5, defaultH: 2 },
  kegging:      { label: "Kegging",      headerBg: "bg-orange-950/80", border: "border-orange-800", badge: "bg-orange-900/60 text-orange-300 border-orange-700",defaultW: 3, defaultH: 2 },
  canning:      { label: "Canning",      headerBg: "bg-rose-950/80",   border: "border-rose-800",   badge: "bg-rose-900/60 text-rose-300 border-rose-700",      defaultW: 3, defaultH: 2 },
  backlog:      { label: "Backlog",      headerBg: "bg-violet-950/80", border: "border-violet-800", badge: "bg-violet-900/60 text-violet-300 border-violet-700",defaultW: 3, defaultH: 4 },
};

export const EQ_TYPES = Object.entries(EQ) as [EquipmentType, typeof EQ[EquipmentType]][];
