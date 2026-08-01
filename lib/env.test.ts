import { describe, it, expect, afterEach } from "vitest";
import { env, APP_URL_FALLBACK } from "./env";

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;

function setAppUrl(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = value;
}

afterEach(() => setAppUrl(ORIGINAL));

describe("env.appUrl", () => {
  it("returns a configured absolute URL unchanged", () => {
    setAppUrl("https://internal.johobrewing.com");
    expect(env.appUrl()).toBe("https://internal.johobrewing.com");
  });

  it("falls back when the variable is unset", () => {
    setAppUrl(undefined);
    expect(env.appUrl()).toBe(APP_URL_FALLBACK);
  });

  // The production regression: the variable existed on Vercel with an empty
  // value, and `??` let it through, so emails shipped host-less paths.
  it("falls back when the variable is set but empty", () => {
    setAppUrl("");
    expect(env.appUrl()).toBe(APP_URL_FALLBACK);
  });

  it("falls back when the variable is whitespace only", () => {
    setAppUrl("   ");
    expect(env.appUrl()).toBe(APP_URL_FALLBACK);
  });

  it("trims surrounding whitespace off a real value", () => {
    setAppUrl("  https://internal.johobrewing.com  ");
    expect(env.appUrl()).toBe("https://internal.johobrewing.com");
  });

  it("strips a trailing slash so path concatenation stays single-slashed", () => {
    setAppUrl("https://internal.johobrewing.com/");
    expect(`${env.appUrl()}/finance/tax/abc`).toBe(
      "https://internal.johobrewing.com/finance/tax/abc",
    );
  });

  it("never returns a value that would yield a host-less link", () => {
    for (const value of [undefined, "", " ", "\t\n", "/"]) {
      setAppUrl(value);
      const link = `${env.appUrl()}/finance/transactions/manual-entries`;
      expect(link.startsWith("http://") || link.startsWith("https://")).toBe(true);
    }
  });
});
