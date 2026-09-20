-- `mbos_lead_validations` HAS DECLARED THREE COLUMNS IT NEVER HAD.
--
-- `src/db/schema.ts` spreads `mbosColumns()` into this table, as every MBOS
-- table does, and that helper declares `client_created_at`, `server_created_at`
-- and `device_id` among the six. `0102`, which created the table, wrote out its
-- own column list and included only three of the six. So the Drizzle schema and
-- the database have disagreed about this table since the day it was made.
--
-- NOTHING FAILED, because nothing selected them. `recordLeadValidationCall`
-- inserts a named list and never sets them; every reader asked for the columns
-- it wanted by name. A divergence in a schema is only a bug once somebody
-- writes the query that trusts it — which is what a `select *`, or a new
-- channel built from the declared shape, eventually is. Here it was the pull:
-- `column k.client_created_at does not exist`, eleven integration tests, and
-- the failure arriving in CI rather than in any local run, because the local
-- database and the declaration are both wrong in the same way.
--
-- Added rather than removed from the declaration, for two reasons. The three
-- are not decoration: `device_id` says which install wrote a row and
-- `client_created_at` is what the handset's own clock said, which is the pair
-- every other MBOS table keeps so that a row can be traced back to the phone
-- that made it. And the office writes this table too, so a validation call has
-- genuinely always had a device or the absence of one to record.
--
-- `server_created_at` takes the same NOT NULL DEFAULT now() the helper
-- declares. On the rows already there that stamps them with the moment of the
-- migration, which is a lie about when the call was made — so it is NOT the
-- column anything should read for that. `called_at` is, it has been correct
-- since `0102`, and the pull already coalesces to it.

ALTER TABLE "mbos_lead_validations"
  ADD COLUMN IF NOT EXISTS "client_created_at" timestamptz;

ALTER TABLE "mbos_lead_validations"
  ADD COLUMN IF NOT EXISTS "server_created_at" timestamptz NOT NULL DEFAULT now();

ALTER TABLE "mbos_lead_validations"
  ADD COLUMN IF NOT EXISTS "device_id" text;
