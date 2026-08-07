import { describe, it, expect } from "vitest";
import { renderPhantomAlertEmail } from "./phantomAlertEmail";
import type { PhantomAlert } from "./phantomExportAlerts";

const alertA: PhantomAlert = {
  exportTransactionId: "et-1",
  recipeId: "r1",
  beerName: "Vienna Lager",
  origin: "draft_swap",
  tapNumber: 3,
  variationId: "pv-1",
  variationName: "1/2 Keg",
  quantityKegs: 1,
  volumeBbl: 0.4032,
  exciseUsd: 2.48,
  occurredAt: "2026-07-18T20:00:00Z",
};

const alertB: PhantomAlert = {
  exportTransactionId: "et-2",
  recipeId: "r2",
  beerName: "Hazy IPA",
  origin: "draft_swap",
  tapNumber: null,
  variationId: "pv-2",
  variationName: "1/6 Keg",
  quantityKegs: 2,
  volumeBbl: 0.5376,
  exciseUsd: 3.31,
  occurredAt: "2026-07-19T14:00:00Z",
};

describe("renderPhantomAlertEmail", () => {
  it("lists beer, tap, date, kegs, volume, and excise for each alert", () => {
    const { html } = renderPhantomAlertEmail([alertA]);
    expect(html).toContain("Vienna Lager");
    expect(html).toContain("3"); // tap number
    expect(html).toContain(alertA.occurredAt);
    expect(html).toContain("1"); // quantityKegs
    expect(html).toContain("0.40"); // volumeBbl, formatted
    expect(html).toContain("2.48"); // exciseUsd
  });

  it("renders a placeholder when tapNumber is null", () => {
    const { html } = renderPhantomAlertEmail([alertB]);
    expect(html).toContain("Hazy IPA");
    expect(html).not.toContain("Tap null");
  });

  it("has a stable subject that reflects the alert count", () => {
    expect(renderPhantomAlertEmail([alertA]).subject).toMatch(/1 open phantom export alert/i);
    expect(renderPhantomAlertEmail([alertA, alertB]).subject).toMatch(/2 open phantom export alerts/i);
  });

  it("renders every alert passed in", () => {
    const { html } = renderPhantomAlertEmail([alertA, alertB]);
    expect(html).toContain("Vienna Lager");
    expect(html).toContain("Hazy IPA");
  });

  it("renders an empty-but-valid email for zero alerts", () => {
    const { subject, html } = renderPhantomAlertEmail([]);
    expect(subject).toMatch(/0 open phantom export alerts/i);
    expect(html).toBeTruthy();
  });
});
