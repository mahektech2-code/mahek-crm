-- ERP simplification, the purchase phase: Purchase inward, the Purchase
-- register and Purchase barcode are tabs of one Purchases screen (its key is
-- `register`). Inward lines are sent to testing or the register as they are
-- saved, so the routing step that justified a screen of its own is gone.
-- Grants move the way 0182 moved them: anybody holding any of the three
-- screens gets Purchases; a narrowed account keeps its dashboard row so the
-- delete can never widen it; the app is copied from the row.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.register'), 1, 16), m."user_id", m."app", 'erp.register', m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp' AND m."module" IN ('erp.inward', 'erp.barcode')
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.dashboard'), 1, 16), m."user_id", m."app", 'erp.dashboard', m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access"
 WHERE "app"::text = 'erp' AND "module" IN ('erp.inward', 'erp.barcode');
--> statement-breakpoint

-- A purchase's bill and its status are one line now: a status past Pending
-- means the bill is in hand. Rows that said otherwise are brought into line.
UPDATE "erp_purchases"
   SET "bill_received" = 'Received'
 WHERE "status" IN ('Invoice Received', 'Purchase Matched', 'Purchase Verified')
   AND coalesce("bill_received", '') <> 'Received';
