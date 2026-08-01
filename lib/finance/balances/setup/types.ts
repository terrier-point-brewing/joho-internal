/**
 * One shape for "what does it take to connect this service", implemented once
 * per service.
 *
 * ── Why a handler interface and not three screens ────────────────────────────
 * Ramp, Plaid and Square each shipped their own Settings page, their own route
 * shape and their own nav entry, and the three ended up looking nothing alike
 * for reasons that were never about the services. Comparing them afterwards,
 * the ONLY real differences are:
 *
 *   * how you get a list of things to connect -- Ramp and Square can just be
 *     asked; Plaid needs the operator to sign in at their bank first;
 *   * whether a credential exists at all -- only Plaid mints one;
 *   * what "prove it works" means.
 *
 * Everything else was duplicated. So a handler declares only those, and the
 * generic route and the shared setup panel do the rest. A fourth service is
 * this file's interface implemented once, with no new screen and no new route.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ConnectionProvider } from "../methods/registry";
import type { ProviderReadiness } from "../methods/setup";

export type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Something an operator can pick to connect. Never carries a credential. */
export interface SetupCandidate {
  /** The service's own id for it, stored as the connection's external_id. */
  externalId: string;
  label: string;
  /** Optional second line — an account type, a mask, a status. */
  sublabel?: string | null;
  /**
   * Set when a connection row already points at this candidate, so the panel
   * offers "connected" rather than creating a second row and tripping the
   * (provider, external_id) unique index with a raw database error.
   */
  connectionId?: string | null;
}

/** Outcome of proving a connection can actually be read right now. */
export type SetupCheckResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

export interface SetupHandler {
  provider: ConnectionProvider;

  /**
   * Whether the APP can talk to this service at all, before any account links
   * anything. Must never throw and must never call the network -- it is asked
   * on every render of the Settings screen, and its whole purpose is to give a
   * straight answer when the credentials are absent.
   */
  readiness(): ProviderReadiness;

  /**
   * What can be connected. Present for `discover` flows.
   *
   * For an `authorize` flow the candidate list does not exist until the
   * operator has signed in, so it comes back from `complete` instead.
   */
  candidates?(supabase: AdminClient): Promise<SetupCandidate[]>;

  /**
   * Begin a browser handshake. Present for `authorize` flows only.
   *
   * Returns whatever the third party's browser SDK needs to open its dialog.
   * `connectionId` is set when repairing an existing connection rather than
   * making a new one.
   */
  authorize?(
    supabase: AdminClient,
    args: { actorId: string; connectionId?: string },
  ): Promise<{ token: string; mode: "create" | "update" }>;

  /**
   * Finish a browser handshake: store any credential server-side, create or
   * update the connection row, and return what can now be chosen.
   *
   * The credential never travels back to the browser, and never arrives from
   * it either -- `payload` carries only the short-lived, single-use artifact
   * the SDK produced.
   */
  complete?(
    supabase: AdminClient,
    args: { actorId: string; payload: string; label?: string; connectionId?: string },
  ): Promise<{ connectionId: string; candidates: SetupCandidate[] }>;

  /** Prove this connection reads. Optional; not every service can be asked cheaply. */
  check?(supabase: AdminClient, connectionId: string): Promise<SetupCheckResult>;
}

/**
 * Reads an environment variable without throwing.
 *
 * lib/env.ts's accessors throw by design, which is right at the point of use --
 * a route that needs a credential should fail loudly. It is wrong for
 * readiness, whose entire job is to report the absence calmly. Plaid's setup
 * screen previously had no such check and surfaced the raw
 * "Missing required environment variable: PLAID_CLIENT_ID" to a bookkeeper.
 */
export function envPresent(...names: string[]): boolean {
  return names.every((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim() !== "";
  });
}
