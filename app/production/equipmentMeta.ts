import { EquipmentType } from "./types";

// Per-equipment-type floorplan chrome. Header/border/badge bind to the
// theme-flipping `--cat-{hue}-*` tokens (dark defaults in app/globals.css,
// light values from BrandChrome) so tiles read on the dark ops canvas AND the
// light brand skin. The headerBg is the category `bg` tint; the tile body
// background is a semantic surface set inline in BrewStatusTab.
const catChrome = (hue: string) => ({
  headerBg: `bg-[var(--cat-${hue}-bg)]`,
  border: `border-[var(--cat-${hue}-bd)]`,
  badge: `bg-[var(--cat-${hue}-bg)] text-[var(--cat-${hue}-fg)] border-[var(--cat-${hue}-bd)]`,
});

export const EQ: Record<EquipmentType, {
  label: string;
  headerBg: string;
  border: string;
  badge: string;
  defaultW: number;
  defaultH: number;
}> = {
  fermenter:    { label: "Fermenter",    ...catChrome("blue"),    defaultW: 2, defaultH: 4 },
  brite:        { label: "Brite",        ...catChrome("cyan"),    defaultW: 2, defaultH: 3 },
  brewhouse:    { label: "Brewhouse",    ...catChrome("amber"),   defaultW: 3, defaultH: 3 },
  cold_storage: { label: "Cold Storage", ...catChrome("sky"),     defaultW: 5, defaultH: 2 },
  kegging:      { label: "Kegging",      ...catChrome("orange"),  defaultW: 3, defaultH: 2 },
  canning:      { label: "Canning",      ...catChrome("rose"),    defaultW: 3, defaultH: 2 },
  backlog:      { label: "Backlog",      ...catChrome("violet"),  defaultW: 3, defaultH: 4 },
  loading_bay:  { label: "Loading Bay",  ...catChrome("stone"),   defaultW: 4, defaultH: 2 },
  export_bay:   { label: "Export Bay",   ...catChrome("emerald"), defaultW: 4, defaultH: 2 },
};

export const EQ_TYPES = Object.entries(EQ) as [EquipmentType, typeof EQ[EquipmentType]][];
