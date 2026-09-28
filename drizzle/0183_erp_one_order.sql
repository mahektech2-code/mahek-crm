-- ERP simplification, the orders phase.
--
-- 1. `erp` becomes an order source: once the ERP is where orders are taken
--    (`erp.orders.live`), `lib/erp/book.ts` writes each ERP order number into
--    `orders` / `bills` keyed `ERP-<n>` / `ERPBILL-<n>`. Nothing here writes
--    one — the switch is off until the client turns it on.
ALTER TYPE "order_source" ADD VALUE IF NOT EXISTS 'erp';
--> statement-breakpoint

-- 2. Today, Tomorrow and Delay were dates written as statuses. They are a
--    planned dispatch date now, and the lines they sat on go back to Under
--    Process — "Today" never let a line be allocated in the ERP either, which
--    only Ready does. The date is the day the status was last set, in the
--    business's zone (never a bare cast of a timestamptz): Today meant that
--    day, Tomorrow the day after, and Delay a day already past, which the
--    screens now call late on their own.
ALTER TABLE "erp_orders" ADD COLUMN IF NOT EXISTS "dispatch_on" date;
--> statement-breakpoint
ALTER TABLE "erp_orders" DROP CONSTRAINT IF EXISTS "erp_orders_status_check";
--> statement-breakpoint
UPDATE "erp_orders"
   SET "dispatch_on" = ("updated_at" AT TIME ZONE 'Asia/Kolkata')::date
                       + CASE WHEN "status" = 'Tomorrow' THEN 1 ELSE 0 END,
       "status" = 'Under Process'
 WHERE "status" IN ('Today', 'Tomorrow', 'Delay');
--> statement-breakpoint
ALTER TABLE "erp_orders" ADD CONSTRAINT "erp_orders_status_check"
  CHECK ("status" in ('Under Process', 'Ready', 'Hold From Office', 'Cancel'));
--> statement-breakpoint

-- 3. The two material stages that named a godown are one "Dispatched" stage;
--    the screen names the godown from the order. "Track / Don't Track" is
--    worked out from the LR and the stage, and the stored copy is brought
--    into line with that rule.
ALTER TABLE "erp_transports" DROP CONSTRAINT IF EXISTS "erp_transports_stage_check";
--> statement-breakpoint
UPDATE "erp_transports"
   SET "material_stage" = 'Dispatched'
 WHERE "material_stage" IN ('Dispatch from Bhiwandi', 'Dispatch from Ambernath');
--> statement-breakpoint
ALTER TABLE "erp_transports" ADD CONSTRAINT "erp_transports_stage_check"
  CHECK ("material_stage" in ('Dispatched', 'In Transit', 'On the way to Destination area', 'Reached Destination Area', 'Close - Received to Party'));
--> statement-breakpoint
ALTER TABLE "erp_transports" ALTER COLUMN "material_stage" SET DEFAULT 'Dispatched';
--> statement-breakpoint
UPDATE "erp_transports"
   SET "track_status" = CASE
         WHEN coalesce("lr_no", '') <> '' AND "material_stage" <> 'Close - Received to Party' THEN 'Track'
         ELSE 'Don''t Track'
       END;
--> statement-breakpoint

-- 4. The sales-order screens and Order details are tabs of one Orders screen,
--    and the order follow-up screens are retired (the CRM's buying cycle
--    already predicts each customer's next order). Grants move the way 0182
--    moved them: anybody holding any old screen gets Orders; a narrowed
--    account keeps its dashboard row so a delete can never widen it; the app
--    is copied from the row, never written as the literal 'erp'.
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.orders'), 1, 16),
       m."user_id",
       m."app",
       'erp.orders',
       m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp'
   AND m."module" IN ('erp.orderInbox', 'erp.pendingOrders', 'erp.readyOrders',
                      'erp.batchCodes', 'erp.labels', 'erp.orderDetails')
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id")
       'mod_' || substr(md5(m."user_id" || '|erp.dashboard'), 1, 16),
       m."user_id",
       m."app",
       'erp.dashboard',
       m."granted_by_id"
  FROM "app_module_access" m
 WHERE m."app"::text = 'erp'
 ORDER BY m."user_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "app_module_access"
 WHERE "app"::text = 'erp'
   AND "module" IN ('erp.orderInbox', 'erp.pendingOrders', 'erp.readyOrders',
                    'erp.batchCodes', 'erp.labels', 'erp.orderDetails',
                    'erp.followup', 'erp.pivot');
--> statement-breakpoint

-- 5. A customer has ONE monthly target: the CRM's Monthly Targets (set from
--    the CRM or Accounts). The ERP kept a standing one of its own on the
--    profile. It is carried into this month's row, where it beats a DEFAULT
--    (a figure computed from trailing sales, which nobody chose) and never a
--    target somebody set by hand; then the ERP's column goes.
INSERT INTO "monthly_targets" ("id", "customer_id", "year", "month", "target_amount", "is_default", "carried_forward")
SELECT 'mt_' || substr(md5(p."customer_id" || '|erp-target'), 1, 16),
       p."customer_id",
       extract(year from now() AT TIME ZONE 'Asia/Kolkata')::int,
       extract(month from now() AT TIME ZONE 'Asia/Kolkata')::int,
       p."monthly_target_paise",
       false,
       false
  FROM "erp_customer_profiles" p
 WHERE coalesce(p."monthly_target_paise", 0) > 0
ON CONFLICT ("customer_id", "year", "month") DO UPDATE
   SET "target_amount" = excluded."target_amount",
       "is_default" = false,
       "updated_at" = now()
 WHERE "monthly_targets"."is_default";
--> statement-breakpoint
ALTER TABLE "erp_customer_profiles" DROP COLUMN IF EXISTS "monthly_target_paise";
