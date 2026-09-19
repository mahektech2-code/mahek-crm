-- What a salesman typed about a competitor and the office never received.
--
-- Both of these have been sent by every handset in the field since the
-- competitor form shipped, and both were dropped in silence. `competitorSchema`
-- is a plain `z.object`, and a plain `z.object` STRIPS what it does not
-- declare: it does not refuse the payload, it does not log, it writes no
-- rejection row and nothing reaches /rejections. The salesman types the answer
-- standing in the shop, the app says saved, the write succeeds, and the column
-- that was never there stays not there.

-- §2.11 — THE WORDS BEHIND THE RATE. A figure alone is half of what was heard:
-- "₹180, but only on a full drum" and "₹180 if he pays the same day" are two
-- different competitive positions wearing one number. The handset has always
-- DISPLAYED this note, which is the quiet part — the salesman read it back on
-- his own phone and had no way of knowing nobody else could.
ALTER TABLE "mbos_competitor_records" ADD COLUMN IF NOT EXISTS "rate_note" text;

-- §2.11 — THEIR CREDIT TERMS, AS THE SHOPKEEPER SAYS THEM, and text rather
-- than the `credit_days` integer beside it. That column is what the handset
-- was being asked for and never sent: it sends `comp.credit.trim()`, free
-- text, and a string where a number is declared is the shape zod drops most
-- quietly of all. The decision is that the text is right and the number was
-- not — "90 on paper, 120 in practice" is the answer worth having, and forcing
-- it into an integer keeps 90 and loses the warning. The same reasoning
-- `lead_requirement` is free text under, while `lead_credit_days_wanted` is an
-- integer: that one is a figure WE have to act on, this one is hearsay about
-- somebody else's arrangement.
ALTER TABLE "mbos_competitor_records" ADD COLUMN IF NOT EXISTS "credit_terms" text;

-- `credit_days` IS KEPT and is not backfilled from the words. It is the
-- countable answer somebody at a desk may one day type, and deriving "60" from
-- "90 on paper, 120 in practice" is the guess this whole column exists to
-- refuse — arriving by the back door, with nobody's name against it. Every row
-- written before today reads exactly as it always has: nulls, because nothing
-- ever reached them.
