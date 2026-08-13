-- What the telecaller was told would happen next, kept on the call itself.
--
-- Six nullable columns and one enum. Every row that existed before this keeps
-- exactly the behaviour it had: a call logged last month has no sentence
-- because nobody was shown one, and nothing here invents a sentence for it.
--
-- These are NOT derived caches. `lib/recompute.ts` does not touch them and
-- must not learn to — the current next step is worked out on read, and this is
-- the record of what somebody was told on the day, which a rebuild would
-- destroy rather than correct.
--
-- Drizzle generated a great deal more than this: 0040, 0041 and 0047 were
-- hand-written, so the stored snapshot had not caught up with them and the
-- generator offered to create objects that already exist. Only the statements
-- belonging to this change are kept. The snapshot beside it is the full
-- generated one, which is correct, so the next generate starts clean.

CREATE TYPE "public"."next_step_kind" AS ENUM('booked', 'scheduled', 'decide', 'none');--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_kind" "next_step_kind";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_date" date;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_reason" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_headline" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_detail" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "next_step_held_today" text;
