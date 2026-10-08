-- A PURCHASE REQUIREMENT IS RAISED BY ONE OF FOUR TEAMS (0232).
--
-- The requirement form offered the "department" reference list beside the
-- three production departments — Production, Godown / Store, Quality,
-- Dispatch, Office, Maintenance — and every one of those let anybody ask for
-- any category. The four teams are a rule in `lib/erp/departments.ts` now
-- (Mixing & Blending, Refilling, Packing, Production Head), so the list is
-- retired: deactivated rather than deleted, because requirements already
-- raised name those labels and keep them.
UPDATE "erp_ref_values" SET "active" = false WHERE "list_key" = 'department';
