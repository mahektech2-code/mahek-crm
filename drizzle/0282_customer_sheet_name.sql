-- A party renamed in the CRM or the ERP keeps the name the sheets call it, so
-- the sheet syncs go on matching it and stop writing the old name back.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sheet_name" text;
