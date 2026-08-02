/**
 * The alert email is the ONLY thing that ever tells anyone a balance is due,
 * and it has never been sent in production -- no account had ever used manual
 * entry, so no close task had ever existed to alert about. There is no
 * accumulated evidence that any of this works. These assertions are it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderBalanceCloseEmail } from "./alertEmail";
import { APP_URL_FALLBACK } from "@/lib/env";

const account = (over: Partial<{ accountName: string; accountNumber: string | null; dueDate: string }> = {}) => ({
  accountName: "Cash on Hand",
  accountNumber: "1010",
  dueDate: "2026-08-05",
  ...over,
});

const original = process.env.NEXT_PUBLIC_APP_URL;
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://internal.example.com";
});
afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = original;
});

describe("renderBalanceCloseEmail", () => {
  it("names the accounts and their deadlines", () => {
    const { subject, html } = renderBalanceCloseEmail([account()], "2026-07-31");
    expect(subject).toContain("2026-07-31");
    expect(subject).toContain("1 account");
    expect(html).toContain("Cash on Hand");
    expect(html).toContain("2026-08-05");
  });

  it("counts more than one account in the plural", () => {
    const { subject } = renderBalanceCloseEmail([account(), account({ accountNumber: "1040" })], "2026-07-31");
    expect(subject).toContain("2 accounts");
  });

  it("deep-links to the period being chased, not to whatever month is current", () => {
    // A month-old alert opening on the current month is how somebody enters
    // the right figure against the wrong period end.
    const { html } = renderBalanceCloseEmail([account()], "2026-07-31");
    expect(html).toContain("/finance/period-close/2026-07-31");
  });

  describe("when the app's public address has not been configured", () => {
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_APP_URL;
    });

    it("prints directions instead of a link to localhost", () => {
      // env.appUrl() falls back to localhost when the variable is unset, which
      // it currently is in the deployment. A localhost anchor is worse than no
      // anchor: it looks like a link and does nothing at all from a phone.
      const { html } = renderBalanceCloseEmail([account()], "2026-07-31");
      expect(html).not.toContain(APP_URL_FALLBACK);
      expect(html).not.toContain("<a href");
      expect(html).toContain("Period Close");
    });
  });

  it("says so when it landed on the admin address only because nobody is assigned", () => {
    // The recipient is being asked to do work that was never given to them,
    // and the fix is a settings change they have no other reason to know about.
    const { html } = renderBalanceCloseEmail([account()], "2026-07-31", true);
    expect(html).toMatch(/nobody is named as responsible/i);
    expect(html).toContain("Balance Sheet Accounts");
  });

  it("stays quiet about assignment when the account does have an owner", () => {
    const { html } = renderBalanceCloseEmail([account()], "2026-07-31", false);
    expect(html).not.toMatch(/nobody is named/i);
  });
});
