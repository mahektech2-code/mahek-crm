-- The Testing list's checks as answered at an SFG lot's QC decision:
-- test name -> Pass | Fail. Empty for every decision made before this.
ALTER TABLE "erp_sfg_qc" ADD COLUMN IF NOT EXISTS "tests" jsonb DEFAULT '{}'::jsonb NOT NULL;
