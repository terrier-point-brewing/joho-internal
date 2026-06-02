export function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

export function cents(n: number): string {
  return (n / 100).toFixed(2);
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
  );
}

export function fmtBbl(v: number): string {
  return v.toFixed(3) + " BBL";
}

export function fmtBbl2(v: number): string {
  return v.toFixed(2) + " BBL";
}
