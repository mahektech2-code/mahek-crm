-- WHAT A MANAGER MADE OF THE PHOTOGRAPHS A DAY PRODUCED.
--
-- Every check-in and every check-out is photographed, and every leg opened
-- from "Start visit" photographs the meter at both ends with the reading typed
-- against it. All of that has been reaching the office for months and none of
-- it has ever been ANSWERED: the attendance screen drew the selfies and the
-- travel ledger drew a "Photo" pill, and neither had anywhere to put the one
-- thing a person looking at a photograph produces, which is a verdict.
--
-- So a photograph nobody had accepted and a photograph nobody had looked at
-- were the same row, on the record a payslip and a mileage claim are read
-- against. This table is the difference between them.
--
-- ONE TABLE FOR TWO KINDS, because it is one act. A selfie and a meter are
-- different evidence and the question asked of both is identical — is this
-- what it says it is — and splitting it would be two tables, two actions, two
-- screens and two answers to "has this day been checked".
--
-- THE KEY IS THE MARK, NOT THE ROW. A day carries six selfies and a leg
-- carries two meters, so `source_id` alone would collapse them onto one
-- verdict and the first written would win — the same failure `timeline_events`
-- solves by putting the stage in the source id, and `source_ref` is spelled
-- the same way: `att:<dayId>:<session>:in|out` and `leg:<legId>:start|end`.
--
-- `reported_km` IS WRITTEN ONCE AND NEVER AGAIN. Correcting a reading
-- overwrites what the salesman typed on the leg itself — that is the point of
-- the correction, since the leg is what the money is worked out from — and
-- this column is the only place the original survives. A second correction
-- must not quietly restate the first as though it had been his.
--
-- WHAT THIS IS NOT is a decision about money. `mbos_approvals` decides the
-- claim and stays the only thing that does; this says whether the evidence
-- under it stood up, which is a question somebody answers BEFORE deciding and
-- which was on no screen at all.
CREATE TYPE "public"."mbos_evidence_kind" AS ENUM('attendance_selfie', 'odometer');--> statement-breakpoint
CREATE TYPE "public"."mbos_evidence_verdict" AS ENUM('accepted', 'declined');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mbos_evidence_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"kind" "mbos_evidence_kind" NOT NULL,
	"source_ref" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"verdict" "mbos_evidence_verdict" NOT NULL,
	"remark" text,
	"reported_km" integer,
	"corrected_km" integer,
	"decided_by_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mbos_evidence_reviews" ADD CONSTRAINT "mbos_evidence_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mbos_evidence_reviews" ADD CONSTRAINT "mbos_evidence_reviews_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- The mark, not the row. See the note above.
CREATE UNIQUE INDEX IF NOT EXISTS "mbos_evidence_reviews_ref_key" ON "mbos_evidence_reviews" USING btree ("source_ref");--> statement-breakpoint
-- The screen's own question: one person, one day.
CREATE INDEX IF NOT EXISTS "mbos_evidence_reviews_day_idx" ON "mbos_evidence_reviews" USING btree ("user_id","day");--> statement-breakpoint
-- A REFUSAL HAS TO SAY WHY, in the database and not only in the action. The
-- salesman is told what a decline said, so a decline with nothing in it is a
-- notification that reads "your odometer reading was rejected" and stops —
-- which teaches people the office is arbitrary rather than telling them what
-- to do differently. Accepting needs no words: the photograph is the reason.
ALTER TABLE "mbos_evidence_reviews" DROP CONSTRAINT IF EXISTS "mbos_evidence_reviews_decline_says_why";--> statement-breakpoint
ALTER TABLE "mbos_evidence_reviews" ADD CONSTRAINT "mbos_evidence_reviews_decline_says_why" CHECK (
	"verdict" <> 'declined' OR ("remark" IS NOT NULL AND length(btrim("remark")) > 0)
);--> statement-breakpoint
-- A CORRECTION BELONGS TO A METER. There is nothing on a selfie to correct —
-- a face is right or it is not — and a kilometre figure against one would be a
-- number no reader of this table could account for.
ALTER TABLE "mbos_evidence_reviews" DROP CONSTRAINT IF EXISTS "mbos_evidence_reviews_km_is_odometer";--> statement-breakpoint
ALTER TABLE "mbos_evidence_reviews" ADD CONSTRAINT "mbos_evidence_reviews_km_is_odometer" CHECK (
	"kind" = 'odometer' OR ("reported_km" IS NULL AND "corrected_km" IS NULL)
);
