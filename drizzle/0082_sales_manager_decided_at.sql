-- The mark that a PERSON decided the sales manager seat, as opposed to
-- `recomputeSalesManagers()` last restating it from the org chart. Null is
-- not "unassigned" — it is "the org chart's own answer stands." See the
-- column's own comment in schema.ts and AGENTS.md's account on why this seat
-- never needed one until the org chart became a real source that restates it.
--
-- IF NOT EXISTS: see 0080's own note.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sales_manager_decided_at" timestamp with time zone;
