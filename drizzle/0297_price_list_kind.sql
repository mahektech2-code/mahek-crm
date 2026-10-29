-- A SHOP'S AGREED PRICES ARE A KIND OF LIST, SAID ON THE ROW.
--
-- Approving a special price used to look for "the shop's special list" as any
-- published list with a customer scope naming the shop — which is also what a
-- shared list ASSIGNED to the shop looks like, so the approval rewrote a rate
-- every other shop on that list was charged. The agreed-prices list is now
-- marked, and only a marked list is ever reused.
ALTER TABLE "price_lists" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_lists" DROP CONSTRAINT IF EXISTS "price_lists_kind_check";
--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_kind_check" CHECK ("kind" in ('standard', 'agreed'));
--> statement-breakpoint
-- The lists a request MADE: its name and its note are the ones
-- decidePriceRequest writes, a request points at it, and it names exactly one
-- shop. A shared list a request merely wrote into carries none of the three.
UPDATE "price_lists" l
   SET "kind" = 'agreed'
 WHERE l."name" LIKE '% — agreed prices'
   AND l."notes" LIKE 'Agreed prices for this shop.%'
   AND EXISTS (SELECT 1 FROM "price_requests" q WHERE q."resulting_list_id" = l."id")
   AND (SELECT count(*) FROM "price_list_scopes" s WHERE s."price_list_id" = l."id") = 1
   AND EXISTS (SELECT 1 FROM "price_list_scopes" s WHERE s."price_list_id" = l."id" AND s."scope_kind" = 'customer');
--> statement-breakpoint
-- The agreed list LAYERS over whatever list the shop is assigned, so its
-- customer scope outranks any other customer scope (see
-- AGREED_SCOPE_PRIORITY in lib/engines/price-resolution.ts).
UPDATE "price_list_scopes" s
   SET "priority" = 1000
  FROM "price_lists" l
 WHERE l."id" = s."price_list_id" AND l."kind" = 'agreed' AND s."scope_kind" = 'customer' AND s."priority" < 1000;
