-- THE TICK NAMES ITS TABLE.
--
-- lib/erp/ledger-cache.ts keeps stock answers under a stamp read from this
-- table. With one stamp, a write to erp_orders or erp_order_details — every
-- Ready, verify, bill and sticker click in the office — threw away the FG,
-- packing and raw-material ledgers and their costing, none of which read
-- either table. Naming the table lets the cache keep a STOCK stamp that those
-- two do not move. Ticks already written have no table and count as stock.
ALTER TABLE "erp_ledger_ticks" ADD COLUMN IF NOT EXISTS "tbl" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION erp_ledger_tick() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO erp_ledger_ticks (tbl) VALUES (TG_TABLE_NAME);
  RETURN NULL;
END
$$;
