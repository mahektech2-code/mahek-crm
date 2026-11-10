-- A billed line that left before the dispatch desk allocated lots (26 Oct 2026)
-- has no lot cost, so its margin was unknown — 4,783 lines since April. The old
-- order sheet costed every one of them in its "Lotcode Costing" column; this is
-- where that figure lands. Filled by `npm run jobs -- sheet-lot-costing`, and
-- read only where a line has no allocated lot.
ALTER TABLE "erp_order_details" ADD COLUMN IF NOT EXISTS "sheet_costing_paise" bigint;
