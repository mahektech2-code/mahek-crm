-- WHAT EACH OUTCOME ASKS FOR.
--
-- Seven of the nine outcomes collected quick notes and a free-text box and
-- nothing else. Quick notes are a good thing and they stay — they are the
-- telecaller's shorthand into the note, which is what a human reads back. What
-- they cannot be is the ANSWER: they are multi-select, managers edit them, none
-- of them is required, and two can be picked at once — so "why did we lose this
-- order" had no single value to count.
--
-- Every column here is null on every row that already exists, and nothing
-- backfills any of it. Guessing a lost-order reason from a quick note somebody
-- happened to tap is a decision dressed up as a migration.

ALTER TABLE "calls" ADD COLUMN "outcome_detail" jsonb;--> statement-breakpoint

-- WHICH ATTEMPT THIS WAS, stamped rather than derived on read.
-- `customers.no_answer_count` is the live counter the queue's own ladder reads
-- and it resets the moment somebody answers, so a call logged as attempt 3
-- would read as attempt 0 a week later and the one question this outcome exists
-- to answer would have no answer left. Same kind of mark as `next_step_*`.
ALTER TABLE "calls" ADD COLUMN "call_attempt" integer;--> statement-breakpoint

-- WHAT THE CUSTOMER IS ASKING FOR, and what routes the complaint.
-- `assigned_to` has defaulted to 'Operations' on every complaint ever raised,
-- which is not a routing decision but the absence of one. The desk is derived
-- from this instead.
ALTER TABLE "complaints" ADD COLUMN "required_action" text;

-- The complaint VOCABULARY — the ten headings, the label-to-enum mapping and the
-- Normal/Urgent/Critical priority — is deliberately NOT here. It is PR #358's
-- (`complaint-vocabulary`), which does all three and more: one complaint form
-- across both screens, a `critical` severity of its own rather than three levels
-- carrying four meanings, an SLA recomputed from when the complaint was RAISED
-- when somebody reclassifies it late, and the handset's five invented categories
-- folded onto the same list.
--
-- Two branches writing one vocabulary is two vocabularies. What is left here is
-- the half that PR does not have: WHAT THE CUSTOMER IS ASKING FOR, which is what
-- routes the complaint to a desk.
