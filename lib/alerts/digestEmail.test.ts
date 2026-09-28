import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderAlertDigestEmail } from "./digestEmail";
import type { AlertGroup } from "./types";
import { CAP } from "@/lib/auth/capabilities";

const group = (over: Partial<AlertGroup> = {}): AlertGroup => ({
  key: "invoices-to-issue",
  label: "Invoices to issue",
  section: "production",
  href: "/production/export?tab=shipments",
  requires: CAP.exportRead,
  items: [
    { key: "i1", title: "Fortnight — Vienna Lager", detail: "3.00 bbl shipped 2026-09-20.", href: "/production/export?tab=shipments", severity: "info", when: "2026-09-20" },
  ],
  ...over,
});

const original = process.env.NEXT_PUBLIC_APP_URL;
beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = "https://internal.example.com"; });
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});

describe("renderAlertDigestEmail", () => {
  it("counts every item in the subject and flags the urgent ones", () => {
    const groups = [
      group(),
      group({ key: "tax", label: "Tax filings due", section: "finance", items: [
        { key: "t1", title: "NC excise was due 2026-09-15", href: "/finance/tax/1", severity: "danger", when: "2026-09-15" },
      ] }),
    ];
    const { subject } = renderAlertDigestEmail(groups, "2026-09-27");
    expect(subject).toBe("TPB alerts — 2 items need attention (1 urgent)");
  });

  it("links every item and every group to the app, and leaves empty groups out", () => {
    const groups = [group(), group({ key: "empty", label: "Shipments to reconcile", items: [] })];
    const { html } = renderAlertDigestEmail(groups, "2026-09-27");
    expect(html).toContain('href="https://internal.example.com/production/export?tab=shipments"');
    expect(html).toContain("Fortnight — Vienna Lager");
    expect(html).toContain("Invoices to issue");
    expect(html).not.toContain("Shipments to reconcile");
    expect(html).toContain("Production");
    expect(html).not.toContain(">Finance<");
  });

  it("names a check that could not run instead of pretending it was clear", () => {
    const groups = [group(), group({ key: "cron", label: "Scheduled jobs", section: "settings", items: [], error: "boom" })];
    const { html } = renderAlertDigestEmail(groups, "2026-09-27");
    expect(html).toContain("Could not check: Scheduled jobs");
    expect(html).not.toContain("boom");
  });

  it("caps a long group and says how many more there are", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, title: `Item ${i}`, href: "/", severity: "info" as const }));
    const { html } = renderAlertDigestEmail([group({ items })], "2026-09-27");
    expect(html).toContain("Item 7");
    expect(html).not.toContain("Item 8");
    expect(html).toContain("and 3 more");
  });

  it("escapes what it prints", () => {
    const { html } = renderAlertDigestEmail([group({ items: [{ key: "x", title: "<script>alert(1)</script>", href: "/", severity: "info" }] })], "2026-09-27");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says the address is missing rather than linking to localhost", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { html } = renderAlertDigestEmail([group()], "2026-09-27");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain("<a ");
    expect(html).toContain("public web address has not been configured");
  });
});
