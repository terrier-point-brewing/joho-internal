// lib/production/bulkCanVariationNaming.ts
import type { PackagingVariationFormat } from "@/app/production/types";

const FORMAT_SUFFIX: Record<PackagingVariationFormat, string> = {
  loose: "",
  "4-pack": "4-Pack",
  "6-pack": "6-Pack",
  case: "Case",
};

export function buildCanSizeLabel(containerName: string): string {
  const stripped = containerName.replace(/\s*blank\s*$/i, "").trim();
  return stripped || containerName.trim();
}

export function buildCanVariationName(input: {
  baseName: string;
  containerName: string;
  format: PackagingVariationFormat;
  isLabeled: boolean;
}): string {
  const sizeLabel = buildCanSizeLabel(input.containerName);
  const canTypeLabel = input.isLabeled ? "Labeled Can" : "Printed Can";
  const suffix = FORMAT_SUFFIX[input.format];
  const base = `${input.baseName} - ${sizeLabel} ${canTypeLabel}`;
  return suffix ? `${base} ${suffix}` : base;
}
