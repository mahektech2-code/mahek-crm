-- The Founder Command Centre is called HQ, and so is the lead source its
-- Quick action writes on a customer it creates.
--
-- `customers.lead_source` is free text and every reader groups by the string,
-- so changing what the code writes WITHOUT moving the rows already carrying
-- the old spelling would leave one channel reported as two — "Founder Command
-- Centre" for everything before the rename and "HQ" after it. This moves them
-- together, which is exactly what the Sources screen's merge
-- (`renameLeadSource`, lib/actions/lead-sources.ts) does by hand.
--
-- And it leaves the same trail that merge does: ONE audit row about the
-- source, not one per customer, with the moved ids in `after_state`. The actor
-- is null because no person did this; a deploy did. Written only when a row
-- actually moved, because an audit entry with no before state is not a record
-- of anything.
WITH moved AS (
  UPDATE "customers"
     SET "lead_source" = 'HQ'
   WHERE "lead_source" = 'Founder Command Centre'
  RETURNING "id"
)
INSERT INTO "audit_log" ("id", "actor_id", "action", "entity_type", "entity_id", "before_state", "after_state")
SELECT 'aud_' || substr(md5(random()::text), 1, 12),
       NULL,
       'lead.source.rename',
       'lead_source',
       'Founder Command Centre',
       jsonb_build_object('source', 'Founder Command Centre', 'leads', count(*)),
       jsonb_build_object('source', 'HQ', 'customerIds', jsonb_agg("id"))
  FROM moved
HAVING count(*) > 0;
