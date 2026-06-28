"use client";

import { NumericFormat, NumericFormatProps } from "react-number-format";

type Variant = "currency" | "volume-bbl" | "integer" | "percent";

const VARIANTS: Record<Variant, Partial<NumericFormatProps>> = {
  currency: { prefix: "$", thousandSeparator: true, decimalScale: 2, fixedDecimalScale: true },
  "volume-bbl": { suffix: " BBL", thousandSeparator: false, decimalScale: 3 },
  integer: { thousandSeparator: true, decimalScale: 0 },
  percent: { suffix: "%", decimalScale: 1 },
};

type FormattedInputProps = {
  variant: Variant;
} & Omit<NumericFormatProps, "prefix" | "suffix" | "thousandSeparator" | "decimalScale" | "fixedDecimalScale">;

export function FormattedInput({ variant, className, ...props }: FormattedInputProps) {
  return (
    <NumericFormat
      {...VARIANTS[variant]}
      {...props}
      className={className}
    />
  );
}
