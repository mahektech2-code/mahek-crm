-- The numbers move out of the workarounds and into the columns that mean them.
--
-- Nothing is invented here: every value written is one already stored
-- somewhere else on the same row. Safe to re-run — each statement writes only
-- where the new column is still null, and the note strip only matches a note
-- that still carries the prefix.
--
-- The shape of a series number is `PREFIX/26-27/0041`, and the prefix is
-- configurable, so the match is on the SHAPE rather than on a literal `MBOS/`.
-- `SHEET-…` and `EXT-…` — the other things `external_ref` holds — cannot look
-- like it.

-- Order numbers, from `orders.external_ref`. The write there continues, since
-- the bill detail screen and the accounts payment search both read it.
UPDATE "orders"
   SET "order_no" = "external_ref"
 WHERE "order_no" IS NULL
   AND "external_ref" ~ '^[A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+$';
--> statement-breakpoint

-- Receipt numbers, from the front of the note the sync prefixed them onto.
UPDATE "payment_receipts"
   SET "receipt_no" = substring("note" from '^Receipt ([A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+)')
 WHERE "receipt_no" IS NULL
   AND "note" ~ '^Receipt [A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+';
--> statement-breakpoint

-- And from the allocation lines, for any receipt whose note was never written
-- or has since been edited. `min` because every line of one receipt carries
-- the same number; there is nothing to choose between.
UPDATE "payment_receipts" r
   SET "receipt_no" = line.ref
  FROM (
        SELECT "receipt_id", min("external_ref") AS ref
          FROM "payments"
         WHERE "external_ref" ~ '^[A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+$'
         GROUP BY "receipt_id"
       ) line
 WHERE r."id" = line."receipt_id"
   AND r."receipt_no" IS NULL;
--> statement-breakpoint

-- The prefix comes off the note, and a note that was ONLY the prefix becomes
-- null rather than an empty string — an empty note is a note somebody left
-- blank, and the two must not be confused on a screen that shows one.
UPDATE "payment_receipts"
   SET "note" = nullif(regexp_replace("note", '^Receipt [A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+( — )?', ''), '')
 WHERE "note" ~ '^Receipt [A-Za-z0-9]+/[0-9]{2}-[0-9]{2}/[0-9]+';
