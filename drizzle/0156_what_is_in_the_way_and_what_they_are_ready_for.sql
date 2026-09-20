-- §5.2 — SECTIONS C AND D OF THE VERIFICATION CALL, which had nowhere to land.
--
-- The PRD gives this call four sections. A and B were built. Of C — what is in
-- the way — this row carried three of the five: price, quality and dispatch.
-- So a shop entirely happy with the price and stuck on the credit terms said so
-- into `salesman_feedback`, which is a free-text impression of the SALESMAN, and
-- the one sentence that decides what we offer next was filed under a question
-- about somebody else. "How many did we lose on credit this quarter" is exactly
-- the report §8 exists to produce, and `ilike '%credit%'` is not an answer to
-- it.
--
-- D was missing outright, and that is the worse half. §5.4 decides whether a
-- sample goes out, and it decides it on whether the SHOP said it was ready for
-- a trial — so the one call that authorises a sample could not record the
-- answer it exists to collect. It reached the next person in prose or not at
-- all.
--
-- TEXT AND NOT BOOLEAN, the same as the three objections already here and for
-- the reason stated beside them: "he came but only for five minutes" is the
-- answer that matters and a tick cannot hold it. "Ready once the season turns"
-- is the same shape, and that clause is the whole of what the next call needs.
--
-- It is also what keeps the distinction the rest of this table keeps. NULL is
-- nobody asked; a filled box is asked, including when the answer is no. A
-- boolean would have collapsed "they have no credit problem" into "we never got
-- to it", which are different facts about one call and would read afterwards as
-- the same lead. The PRD calls C and D multi-selects; several being true at
-- once is what a column each gives, with the shop's own words beside each one,
-- and a ticked box gives the count alone.
--
-- `competitor_concern` is NOT `confirmed_competitor`. That column is WHOSE
-- product they use; this is what holds them to it — a rebate, a relationship,
-- stock already on the shelf. Knowing the incumbent's name says nothing about
-- how hard they are to displace.
--
-- Every one is nullable, which is why this moves nothing: every call already
-- recorded keeps reading exactly as it read, as five questions nobody was
-- asked, because nobody was.
ALTER TABLE "mbos_lead_validations" ADD COLUMN IF NOT EXISTS "credit_concern" text;--> statement-breakpoint
ALTER TABLE "mbos_lead_validations" ADD COLUMN IF NOT EXISTS "competitor_concern" text;--> statement-breakpoint
ALTER TABLE "mbos_lead_validations" ADD COLUMN IF NOT EXISTS "ready_for_trial" text;--> statement-breakpoint
ALTER TABLE "mbos_lead_validations" ADD COLUMN IF NOT EXISTS "ready_for_commercial" text;--> statement-breakpoint
ALTER TABLE "mbos_lead_validations" ADD COLUMN IF NOT EXISTS "ready_for_order" text;
