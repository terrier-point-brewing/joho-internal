export function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

export function cents(n: number): string {
  return (n / 100).toFixed(2);
}

// Anchor date-only strings to local noon so UTC-behind timezones don't roll
// them back a day.  Full ISO timestamps (containing "T") are left unchanged.
function anchored(iso: string): Date {
  return new Date(iso.includes("T") ? iso : iso.slice(0, 10) + "T12:00:00");
}

export function fmtDate(iso: string): string {
  return anchored(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtDateLong(iso: string): string {
  return anchored(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtCents(n: number): string {
  return fmtUsd(n / 100);
}

export function fmtUsd0(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
