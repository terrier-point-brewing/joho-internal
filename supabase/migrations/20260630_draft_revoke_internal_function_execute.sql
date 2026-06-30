-- DRAFT — DO NOT APPLY WITHOUT REVIEW
--
-- Finding S3 (schema audit 2026-06-30): four SECURITY DEFINER functions are executable by
-- the `anon` and/or `authenticated` PostgREST roles via /rest/v1/rpc/<name>:
--   * audit_trigger_fn()                     — trigger fn, must never be called directly
--   * handle_new_user()                      — auth trigger fn, must never be called directly
--   * backfill_recipe_link_variation_ids()   — one-shot backfill, should not stay callable
--   * get_my_role()                          — role lookup; SHOULD stay callable by
--                                              `authenticated` (powers role checks),
--                                              so we only revoke `anon` on it.
-- Source: get_advisors(security) lints 0028/0029 on the live DB (read-only). Not run.
--
-- Reviewer notes:
--   * Confirm each function's exact 0-arg signature still matches before applying.
--   * If any of these are intentionally exposed as RPC, drop the corresponding REVOKE.

revoke execute on function public.audit_trigger_fn() from anon, authenticated, public;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.backfill_recipe_link_variation_ids() from anon, authenticated, public;

-- get_my_role: revoke only from anon; keep authenticated EXECUTE.
revoke execute on function public.get_my_role() from anon, public;
