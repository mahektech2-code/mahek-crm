-- THE STOCK LEDGERS' TICK.
--
-- Stock is read off the whole history of its ledgers on every page
-- (lib/erp/stock.ts), and on the real book that is a fifth of a second a
-- ledger, several times a page. lib/erp/ledger-cache.ts keeps the answer
-- between requests and needs to know, exactly, when it stopped being true.
--
-- Every statement that writes to a table those reads touch adds one row here.
-- The cache's stamp is the count and the highest id, read in the reader's own
-- snapshot: a row is visible only once the write that added it has committed,
-- so a cached answer is thrown away the moment a committed write could have
-- changed it — whoever wrote it, from whichever process or script. It is an
-- INSERT and nothing else, so no writer ever waits on another for it.
--
-- A statement trigger fires even for a statement that changed no row. That
-- costs one needless re-read, never a stale one.
CREATE TABLE IF NOT EXISTS "erp_ledger_ticks" (
  "id" bigserial PRIMARY KEY,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION erp_ledger_tick() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO erp_ledger_ticks DEFAULT VALUES;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_batch_codes";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_batch_codes" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_fg_entries";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_fg_entries" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_fg_fills";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_fg_fills" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_godowns";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_godowns" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_order_details";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_order_details" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_orders";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_orders" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_pack_entries";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_pack_entries" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_pack_lines";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_pack_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_pr_costs";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_pr_costs" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_product_packing";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_product_packing" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_purchases";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_purchases" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_raw_materials";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_raw_materials" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_return_outwards";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_return_outwards" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_rm_entries";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_rm_entries" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_sfg_entries";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_sfg_entries" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_sfg_lines";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_sfg_lines" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "erp_transfers";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "erp_transfers" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "finished_goods";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "finished_goods" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "product_formulations";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "product_formulations" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
--> statement-breakpoint
DROP TRIGGER IF EXISTS erp_ledger_tick ON "products";
--> statement-breakpoint
CREATE TRIGGER erp_ledger_tick AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "products" FOR EACH STATEMENT EXECUTE FUNCTION erp_ledger_tick();
