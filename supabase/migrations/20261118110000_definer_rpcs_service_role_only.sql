-- APPLY AFTER THE PARTNER-PORTAL DEPLOY IS LIVE.
--
-- Four SECURITY DEFINER functions were executable by every logged-in session
-- and check nothing about the caller — RLS does not apply inside them. That was
-- already too wide for a viewer; with external partner logins it is a way
-- around the partner deny. Their two app callers (the ingredient unit
-- conversion route and reviseShipment) now call them through the service-role
-- client, behind requirePermission, so no session needs EXECUTE at all.
--
-- Grants survive CREATE OR REPLACE, so a later rewrite of a body keeps this.
revoke execute on function public.convert_ingredient_unit(uuid, text) from public, anon, authenticated;
revoke execute on function public.reverse_shipment(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.coa_reference_count(uuid) from public, anon, authenticated;
revoke execute on function public.ingredient_has_dependents(uuid) from public, anon, authenticated;
grant execute on function public.convert_ingredient_unit(uuid, text) to service_role;
grant execute on function public.reverse_shipment(uuid, text, text) to service_role;
grant execute on function public.coa_reference_count(uuid) to service_role;
grant execute on function public.ingredient_has_dependents(uuid) to service_role;
