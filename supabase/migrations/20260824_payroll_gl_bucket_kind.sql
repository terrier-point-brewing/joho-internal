ALTER TABLE payroll_gl_report_totals
  ADD COLUMN bucket_kind text NOT NULL DEFAULT 'wages'
    CHECK (bucket_kind IN ('wages', 'employer_tax', 'tips'));
