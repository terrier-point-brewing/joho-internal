import { describe, expect, it } from "vitest";
import { partnerMayReach } from "./confinement";

describe("partnerMayReach", () => {
  it("opens the portal, its API, and the auth plumbing", () => {
    for (const p of ["/partner", "/partner/anything", "/api/partner/overview", "/api/partner/requests/abc", "/api/auth/me", "/auth/set-password"]) {
      expect(partnerMayReach(p), p).toBe(true);
    }
  });

  it("closes everything else — including lookalike prefixes", () => {
    for (const p of [
      "/", "/taproom/performance", "/production/partners", "/production/intake", "/finance/financials", "/settings/user/account",
      "/partners", "/partnership", "/api/partners/contract-brewing", "/api/production/partner-requests", "/api/production/partner-ledger",
      "/api/production/recipes", "/api/admin/users", "/api/authx",
    ]) {
      expect(partnerMayReach(p), p).toBe(false);
    }
  });
});
