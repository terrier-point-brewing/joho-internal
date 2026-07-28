ALTER TABLE payroll_gl_settings
  ADD COLUMN tips_chart_of_accounts_id uuid REFERENCES chart_of_accounts(id);

UPDATE payroll_gl_settings
   SET tips_chart_of_accounts_id = (
     SELECT id FROM chart_of_accounts
      WHERE account_name = 'Payroll Liabilities:Undistributed Tips'
      LIMIT 1
   )
 WHERE tips_chart_of_accounts_id IS NULL;
