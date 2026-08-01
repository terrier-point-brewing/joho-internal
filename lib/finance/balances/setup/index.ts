/**
 * The setup handler registry.
 *
 * One entry per external service. Adding a fourth is this file plus one
 * implementation of SetupHandler -- no route, no screen, no nav entry.
 */
import type { ConnectionProvider } from "../methods/registry";
import type { ProviderReadiness } from "../methods/setup";
import type { SetupHandler } from "./types";
import { rampSetup } from "./ramp";
import { squareSetup } from "./square";
import { plaidSetup } from "./plaid";

export type { SetupHandler, SetupCandidate, SetupCheckResult } from "./types";

const HANDLERS: SetupHandler[] = [rampSetup, squareSetup, plaidSetup];

export function getSetupHandler(provider: string): SetupHandler | undefined {
  return HANDLERS.find((h) => h.provider === provider);
}

/**
 * App-level configuration state for every service, for the Settings screen.
 *
 * Computed on every load rather than cached: it reads environment variables
 * only, so it costs nothing, and a stale "not configured" after a redeploy
 * would be worse than useless -- it is the message telling someone the thing
 * they just fixed is still broken.
 */
export function allProviderReadiness(): Map<ConnectionProvider, ProviderReadiness> {
  return new Map(HANDLERS.map((h) => [h.provider, h.readiness()]));
}

/**
 * Readiness plus which actions this service actually supports.
 *
 * The setup panel needs this to decide what to render: a "Test this connection"
 * button on a service with no `check` would 409 on click, and a service is only
 * as generic as the client's knowledge of what it can be asked to do. Derived
 * from the handler's own shape rather than declared twice.
 */
export interface ProviderCapability extends ProviderReadiness {
  canDiscover: boolean;
  canAuthorize: boolean;
  canCheck: boolean;
}

export function allProviderCapabilities(): Record<string, ProviderCapability> {
  return Object.fromEntries(
    HANDLERS.map((h) => [
      h.provider,
      {
        ...h.readiness(),
        canDiscover: typeof h.candidates === "function",
        canAuthorize: typeof h.authorize === "function",
        canCheck: typeof h.check === "function",
      },
    ]),
  );
}
