-- A commitment born by splitting another (a conversion carried part of the
-- deal into a different beer) records its parent deal as a real reference,
-- not a free-text note. Read by the deposit-coverage view to show which deal
-- — and therefore which deposit invoice — covered the base ingredients.
alter table commitments
  add column if not exists split_from_commitment_id uuid references commitments(id);

comment on column commitments.split_from_commitment_id is
  'Deal this commitment was split from when a conversion moved part of it into another recipe (splitCommitmentForConversionChild). Null for original deals.';
