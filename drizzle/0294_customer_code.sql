-- CUSTOMER CODE: one generated code per account, "CUS-00001".
--
-- `external_code` is NOT the customer code, though the edit form used to label
-- it that way. The order-sheet projection writes `SHEET:<NAME>` there and finds
-- the party by it on every pass, so it is a join key and must not be retyped.
-- The code a person reads and quotes is this column: set by the database on
-- every insert (whatever path writes the row — the sheet, the CRM, Accounts,
-- the handset), never typed, never changed.
--
-- Existing accounts are numbered in the order they were created. Additive and
-- idempotent.
CREATE SEQUENCE IF NOT EXISTS "customer_code_seq";
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "customer_code" text;
--> statement-breakpoint
UPDATE "customers" c SET "customer_code" = n.code
  FROM (
    SELECT id, 'CUS-' || lpad(nextval('customer_code_seq')::text, 5, '0') AS code
      FROM (SELECT id FROM "customers" WHERE "customer_code" IS NULL ORDER BY "created_at", "id") o
  ) n
 WHERE c.id = n.id;
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "customer_code" SET DEFAULT ('CUS-' || lpad(nextval('customer_code_seq')::text, 5, '0'));
--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "customer_code" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_customer_code_key" ON "customers" ("customer_code");
