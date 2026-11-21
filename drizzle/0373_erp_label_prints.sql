-- EVERY DRUM-LABEL PRINT, REPRINTS INCLUDED. Drum labels (erp.barcode) splits
-- into To print and Printed, and "printed" has to be a fact somebody can read
-- back: when, by whom, how many times. One row per purchased lot per print,
-- written by the label page where it actually printed (sent to the label
-- printer, saved as a print file, or the print dialog shown). `reprint` says
-- the lot had been printed before. A voided lot takes its rows with it.
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS "erp_label_prints" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_id" text NOT NULL REFERENCES "erp_purchases"("id") ON DELETE CASCADE,
	"copies" integer NOT NULL,
	"reprint" boolean DEFAULT false NOT NULL,
	"printed_by_id" text REFERENCES "users"("id"),
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_label_prints_copies_check" CHECK ("copies" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_label_prints_purchase_idx" ON "erp_label_prints" USING btree ("purchase_id","printed_at");
