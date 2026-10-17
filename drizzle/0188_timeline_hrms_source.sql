-- HRMS's sales desk writes the calls it plans and logs into the customer's
-- shared history, beside the CRM's and the handset's. Nothing in this file uses
-- the new value, because Postgres refuses to use an enum value in the
-- transaction that adds it and drizzle-kit applies every pending migration in
-- one transaction.
ALTER TYPE "public"."timeline_source_app" ADD VALUE IF NOT EXISTS 'hrms';
