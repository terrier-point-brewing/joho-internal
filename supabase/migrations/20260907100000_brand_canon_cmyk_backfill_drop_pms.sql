-- Brand canon: derive CMYK for every palette color, and drop Pantone entirely.
--
-- ── CMYK ────────────────────────────────────────────────────────────────────
-- Only the four Tier-1 colors carried `cmyk`; the ten neutrals carried none, so
-- no print collateral could quote a press value for a surface or a text step.
--
-- The four authored values turn out to be the plain hex→CMYK conversion,
-- exactly — indigo "59 43 0 64", paper "0 2 6 4", seal-red "0 85 74 32",
-- camphor "0 8 26 30" all reproduce from their hex with no rounding slack. So
-- deriving the remainder the same way is consistent with what is already
-- published rather than introducing a second provenance. The SQL below is the
-- same formula as lib/brand/cmyk.ts (`cmykFromHex`), which is unit-tested
-- against those four values precisely so this can never silently diverge.
--
-- These are PROCESS values, not press-proofed ones: no ICC profile is involved,
-- so a critical job should still be proofed under its actual condition.
--
-- Colors that already have a `cmyk` are left alone — an authored override
-- always wins over the derivation.
--
-- ── Pantone ─────────────────────────────────────────────────────────────────
-- `pms` is REMOVED from every color, not just left empty. It was populated on
-- the four Tier-1 colors and nowhere else, there is no maintained source for
-- the rest (Pantone is a licensed system with no derivable mapping from hex),
-- and a half-populated spot column on a guide that people copy values out of is
-- worse than an absent one. Spot matching becomes a prepress conversation with
-- the printer, from the hex and the process CMYK.
--
-- ⚠️ This DROPS DATA: four Pantone numbers (534 C, 9080 C, 187 C, 4525 C).
-- They remain readable forever in the archived canon rows, which are untouched
-- below, and in this comment. Removal was explicitly requested.
--
-- Only draft + published rows are rewritten. Archived rows are historical
-- snapshots and stay byte-for-byte as published — same rule as 20260818.
-- getCanon() does not validate on read, so archived rows keeping `pms` after it
-- leaves the Zod schema is safe; History renders them unchanged.
--
-- Idempotent: re-running finds every color already has `cmyk` and no `pms`, and
-- rewrites each document to itself.
--
-- Human-gated (do not auto-apply).

-- Mirrors lib/brand/cmyk.ts. Returns null for anything that is not a 6-digit
-- hex so the caller can leave such an entry untouched rather than write "null".
create or replace function public.brand_cmyk_from_hex(hex text)
returns text
language plpgsql
immutable
as $$
declare
  r numeric; g numeric; b numeric; k numeric;
begin
  if hex is null or hex !~* '^#?[0-9a-f]{6}$' then
    return null;
  end if;

  hex := right(hex, 6);
  r := ('x' || substr(hex, 1, 2))::bit(8)::int / 255.0;
  g := ('x' || substr(hex, 3, 2))::bit(8)::int / 255.0;
  b := ('x' || substr(hex, 5, 2))::bit(8)::int / 255.0;

  k := 1 - greatest(r, g, b);
  -- Pure black: the c/m/y denominator would be zero; K carries the whole load.
  if k = 1 then
    return '0 0 0 100';
  end if;

  return concat_ws(' ',
    round((1 - r - k) / (1 - k) * 100),
    round((1 - g - k) / (1 - k) * 100),
    round((1 - b - k) / (1 - k) * 100),
    round(k * 100)
  );
end $$;

update public.brand_canon_versions
set document = jsonb_set(
  document,
  '{palette}',
  (
    select coalesce(jsonb_agg(
      -- Drop pms unconditionally; add cmyk only where it is absent and the hex
      -- is parseable (coalesce keeps the authored value when one exists).
      (color - 'pms')
        || case
             when coalesce(
                    nullif(color ->> 'cmyk', ''),
                    public.brand_cmyk_from_hex(color ->> 'hex')
                  ) is null
               then '{}'::jsonb
             else jsonb_build_object(
                    'cmyk',
                    coalesce(
                      nullif(color ->> 'cmyk', ''),
                      public.brand_cmyk_from_hex(color ->> 'hex')
                    )
                  )
           end
      order by idx
    ), '[]'::jsonb)
    from jsonb_array_elements(document -> 'palette') with ordinality as t(color, idx)
  )
)
where status in ('draft', 'published')
  and document ? 'palette';

-- The helper exists only for this migration.
drop function if exists public.brand_cmyk_from_hex(text);

-- Verification (expects every color to have cmyk, and none to have pms):
--   select c ->> 'key', c ->> 'hex', c ->> 'cmyk', c ? 'pms' as has_pms
--   from public.brand_canon_versions v,
--        jsonb_array_elements(v.document -> 'palette') c
--   where v.status = 'published';
