# Final Review Fix Report — Spec 7 (Export Settings + Barrel Excise Tax)

## Issue 1: GET routes 403 for brewer and manager

`requireRole(allowedRoles)` (see `lib/auth.ts`) is not a hierarchy — it admits a request only if `role === "admin"` or `allowedRoles.includes(role)`. Three GET handlers used `requireRole(["viewer"])`, which 403s brewer and manager despite the spec requiring reads open to all authenticated roles.

Fixed by changing `requireRole(["viewer"])` to `requireRole(["viewer", "brewer", "manager"])` in the GET handler of each file (write handlers left untouched, still `requireRole(["brewer"])`):

- `app/api/production/export-settings/excise-tax-rates/route.ts` — `GET()`
- `app/api/production/export-settings/service-mappings/route.ts` — `GET(req)`
- `app/api/production/export-settings/square-catalog/route.ts` — `GET()`

## Issue 2: upsert can't dedupe NULL-keyed default rows

`supabase/migrations/20260624_export_settings.sql` declared:

```sql
unique (service_type, partner_id, packaging_item_id)
```

Postgres treats NULL as distinct from NULL, so for `keg_cleaning`/`forklift`/`bulk_discount` rows (where `partner_id` and `packaging_item_id` are always NULL) the constraint never deduplicated, making the route's `onConflict: "service_type,partner_id,packaging_item_id"` upsert silently ineffective for those rows.

Fixed in place (migration not yet applied to live DB, so editing directly is safe) by changing the constraint to:

```sql
unique nulls not distinct (service_type, partner_id, packaging_item_id)
```

## Verification

Ran `npm run build` — succeeded. Full route manifest generated with no errors; only pre-existing turbopack workspace-root warning about multiple lockfiles (unrelated, present due to worktree setup).

```
✓ Build completed successfully (all routes compiled, no type/lint errors)
⚠ Warning: Next.js inferred your workspace root... (pre-existing, unrelated to this change)
```
