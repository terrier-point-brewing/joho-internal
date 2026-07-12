import type { TaxPartyTemplate } from "./types";

const partyRegistry = new Map<string, TaxPartyTemplate>();

/**
 * Register a party template in the in-memory registry.
 * @param template - The party template to register
 */
export function registerParty(template: TaxPartyTemplate): void {
  partyRegistry.set(template.key, template);
}

/**
 * Retrieve a party template by its key.
 * @param key - The unique key of the party template
 * @returns The party template
 * @throws Error if the party template key is not found
 */
export function getParty(key: string): TaxPartyTemplate {
  const party = partyRegistry.get(key);
  if (!party) {
    throw new Error(`Party template not found: ${key}`);
  }
  return party;
}

/**
 * List all registered party templates.
 * @returns An array of all registered party templates
 */
export function listParties(): TaxPartyTemplate[] {
  return Array.from(partyRegistry.values());
}
