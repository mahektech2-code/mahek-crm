-- A PURCHASE REQUIREMENT NO LONGER WAITS ON A BLIND COUNT (Nov 2026). Every
-- requirement used to open a count of its item at its godown and hold its
-- purchase method until the count was entered. The step is gone from the flow,
-- so a count still OPEN only because a requirement was waiting on it is
-- cancelled, with the reason, rather than left on Stock accuracy → To count
-- and the factory phones as work nobody needs. A count already entered keeps
-- its figure, its verdict and any red flag it raised: that is what the shelf
-- held, and stock control follows it up as before.
UPDATE "erp_stock_counts"
   SET "status" = 'cancelled',
       "resolution" = 'cancelled',
       "resolution_note" = 'Not needed: a purchase requirement no longer waits on a blind count.',
       "resolved_at" = now()
 WHERE "status" = 'open'
   AND "kind" = 'reorder'
   AND "requisition_id" IS NOT NULL
   AND "recount_of_id" IS NULL;
