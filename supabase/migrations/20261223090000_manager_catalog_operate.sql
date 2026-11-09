-- Taproom manager owns the Square / app catalog side of a new recipe: once the
-- brewer has brewed it, the manager maps it in Square Item Mappings. That
-- screen and its write routes gate on `catalog`, which manager did not hold.
--
-- `operate`, not `manage`: "Refresh from Square" is finance.transactions:manage
-- and stays out of reach. The 20260826 seed is edited to match so
-- roleBundleSeedParity keeps the file and ROLE_BUNDLES in step.
insert into public.role_permission_grants (role, scope, level)
values ('manager', 'catalog', 'operate')
on conflict (role, scope) do update set level = excluded.level;
