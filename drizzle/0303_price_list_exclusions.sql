-- A LIST MAY LEAVE SOMEBODY OUT, AND A SHOP IS ON ONE LIST.
--
-- `excluded` marks a scope row that takes shops OFF its list rather than
-- putting them on: a named shop, a salesman's shops, a beat, an area, a city
-- or a district the list would otherwise reach. Everybody and a customer type
-- are never left out — leaving out "everybody" is not having the list at all.
-- Nothing already stored is excluded, so adding the column moves no price.
ALTER TABLE "price_list_scopes" ADD COLUMN IF NOT EXISTS "excluded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_list_scopes" DROP CONSTRAINT IF EXISTS "price_list_scopes_excluded_kind";
--> statement-breakpoint
ALTER TABLE "price_list_scopes" ADD CONSTRAINT "price_list_scopes_excluded_kind"
  CHECK (NOT "excluded" OR "scope_kind" IN ('customer', 'salesman', 'beat', 'area', 'city', 'district'));
--> statement-breakpoint

-- Shops a draft will take from other lists when it is published: "move here"
-- answered while the list was still a draft. Applied, and cleared, by the
-- publish; read by nothing else.
ALTER TABLE "price_lists" ADD COLUMN IF NOT EXISTS "pending_moves" jsonb;
