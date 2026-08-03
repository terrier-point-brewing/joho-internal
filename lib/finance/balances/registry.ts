import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { CoaAccountRef } from "../financials/types";

export type ProviderKind = "derived" | "integration" | "manual";

export interface BalanceContext {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  /** "YYYY-MM-DD", always a month end. */
  periodEnd: string;
  coaId: string;
  config: Record<string, unknown>;
  /**
   * Per-run memo, supplied by expandSources. Optional: a provider called
   * directly (tests, a one-off script) simply reads afresh. See sharedRead.
   */
  shared?: SharedComputeCache;
}

/**
 * Reads that are identical for every account in ONE expandSources pass,
 * memoized for the life of that pass and thrown away with it.
 *
 * Request-scoped rather than module-scoped on purpose. A module-level cache
 * would outlive the request that filled it and hand a second, later request a
 * balance computed from figures that have since moved -- the plausible-but-wrong
 * shape that a stale number is, with nothing on screen to say so.
 *
 * It holds PROMISES, not values, because the accounts now run concurrently:
 * two accounts reaching the same read in the same tick must join one in-flight
 * fetch, which a value cache (empty until the first one resolves) would miss.
 */
export type SharedComputeCache = Map<string, Promise<unknown>>;

export function createSharedComputeCache(): SharedComputeCache {
  return new Map();
}

/**
 * Runs `read` once per `key` per run, or every time when no cache is present.
 *
 * `key` must name everything the read depends on. Anything varying by account
 * does NOT belong here -- the whole point is that these reads do not.
 *
 * A rejected read stays cached: the second caller asked for the same work and
 * would get the same failure, and re-running it would only spend the request's
 * time proving that twice.
 */
export function sharedRead<T>(ctx: BalanceContext, key: string, read: () => Promise<T>): Promise<T> {
  if (!ctx.shared) return read();
  const inFlight = ctx.shared.get(key);
  if (inFlight) return inFlight as Promise<T>;
  const started = read();
  ctx.shared.set(key, started);
  return started;
}

export interface BalanceProvider {
  key: string;
  label: string;
  kind: ProviderKind;
  /** Filters which accounts this provider is offerable for in the Settings dropdown. */
  appliesTo?: (coa: CoaAccountRef) => boolean;
  /**
   * True when this provider's answer depends on how things stand TODAY rather
   * than on how they stood at `periodEnd`, so it cannot be asked honestly about
   * an older month.
   *
   * `openInvoiceAr` is the case that named this: it sums invoices whose status
   * is 'open' NOW. Run it against March and it counts only the March invoices
   * still unpaid today, which is not March's receivables -- it is a subset of
   * them, silently, with no way to tell from the figure. Every invoice
   * subsequently paid simply vanishes.
   *
   * Providers so marked are excluded from any snapshot of a month older than
   * the one currently being closed, and -- because a partial sum is worse than
   * no answer at all (see snapshot.ts's per-account failure rule) -- they take
   * their whole account out with them.
   */
  dependsOnCurrentState?: boolean;
  /** Internal-convention cents (assets positive, liabilities/equity negative), or null when the balance cannot be determined. */
  compute(ctx: BalanceContext): Promise<number | null>;
}

const providerRegistry = new Map<string, BalanceProvider>();

/**
 * Register a balance provider in the in-memory registry.
 * @param p - The balance provider to register
 * @throws Error if a provider with the same key is already registered
 */
export function registerProvider(p: BalanceProvider): void {
  if (providerRegistry.has(p.key)) {
    throw new Error(`Balance provider already registered: ${p.key}`);
  }
  providerRegistry.set(p.key, p);
}

/**
 * Retrieve a balance provider by its key.
 * @param key - The unique key of the balance provider
 * @returns The balance provider, or undefined if not found
 */
export function getProvider(key: string): BalanceProvider | undefined {
  return providerRegistry.get(key);
}

/**
 * List all registered balance providers.
 * @returns An array of all registered balance providers
 */
export function listProviders(): BalanceProvider[] {
  return Array.from(providerRegistry.values());
}

/** Test-only: clears the registry between tests. Not for use outside tests. */
export function __resetRegistry(): void {
  providerRegistry.clear();
}
