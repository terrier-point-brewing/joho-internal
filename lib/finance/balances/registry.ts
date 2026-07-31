import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { CoaAccountRef } from "../financials/types";

export type ProviderKind = "derived" | "integration" | "manual";

export interface BalanceContext {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  /** "YYYY-MM-DD", always a month end. */
  periodEnd: string;
  coaId: string;
  config: Record<string, unknown>;
}

export interface BalanceProvider {
  key: string;
  label: string;
  kind: ProviderKind;
  /** Filters which accounts this provider is offerable for in the Settings dropdown. */
  appliesTo?: (coa: CoaAccountRef) => boolean;
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
