-- ============================================================================
-- Security advisor hardening — pin function search_path + remove anon/auth
-- RPC access to internal SECURITY DEFINER functions.
--
-- Clears these Supabase security-advisor findings:
--   * 0011 function_search_path_mutable
--   * 0028 anon_security_definer_function_executable
--   * 0029 authenticated_security_definer_function_executable
--
-- Verified against prod 2026-07-09 (signatures, security_definer flags, callers).
-- Idempotent: ALTER … SET search_path, REVOKE, and GRANT are all re-runnable.
-- ============================================================================

-- 1. Pin search_path on every function flagged mutable. `= public` matches the
--    existing convention (get_my_role, handle_new_user, audit_trigger_fn).
alter function public.set_updated_at()                     set search_path = public;
alter function public.set_expense_updated_at()             set search_path = public;
alter function public.set_payroll_entries_updated_at()     set search_path = public;
alter function public.recompute_variation_total_volume()   set search_path = public;
alter function public.record_batch_transfer(uuid, uuid, uuid, numeric, numeric, text, text, uuid, numeric, uuid)
                                                           set search_path = public;
alter function public.create_batch_with_consumption(text, date, date, numeric, integer, text, text, uuid)
                                                           set search_path = public;
alter function public.backfill_recipe_link_variation_ids() set search_path = public;
alter function public.finance_reader_roles()               set search_path = public;
alter function public.payroll_reader_roles()               set search_path = public;

-- 2. Remove Data-API (anon/authenticated) EXECUTE on internal SECURITY DEFINER
--    functions so they are not callable via /rest/v1/rpc/*.
--
--    handle_new_user + audit_trigger_fn are TRIGGER functions — trigger firing
--    does not check EXECUTE, so revoking every grant does not affect them.
revoke execute on function public.handle_new_user()  from public, anon, authenticated;
revoke execute on function public.audit_trigger_fn() from public, anon, authenticated;

--    backfill_recipe_link_variation_ids is still called — but only by the
--    catalog-sync route via the service_role (admin) client. Revoke public/anon/
--    authenticated and keep service_role so that app path keeps working.
revoke execute on function public.backfill_recipe_link_variation_ids() from public, anon, authenticated;
grant  execute on function public.backfill_recipe_link_variation_ids() to service_role;

-- NOTE: get_my_role() is deliberately left SECURITY DEFINER and executable by
-- anon + authenticated. Every role-scoped RLS policy evaluates it, and it MUST be
-- DEFINER to read `profiles` without recursing through that table's own RLS
-- (whose "Admins can read all profiles" policy itself calls get_my_role). It only
-- ever returns the caller's own role, so leaving it callable is not an exposure.
-- Its advisor warning is an accepted, documented exception.
