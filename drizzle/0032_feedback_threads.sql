-- A feedback report becomes a conversation.
--
-- `feedback.admin_note` was one overwritable cell: a second answer erased the
-- first, and the person who wrote the report could not say anything back. What
-- was written to somebody stays written, so every existing note is carried
-- into the thread as the message it always was, attributed to whoever wrote it.
--
-- Hand-written rather than generated: `drizzle-kit generate` diffs against the
-- last snapshot in meta/, and this repository's snapshots stop at 0027 — so a
-- generated file re-emits four migrations' worth of statements that are
-- already applied.

ALTER TYPE "public"."attachment_parent" ADD VALUE 'feedback';--> statement-breakpoint
ALTER TYPE "public"."attachment_parent" ADD VALUE 'feedback_message';--> statement-breakpoint

CREATE TABLE "feedback_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"feedback_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text,
	"status_to" "feedback_status",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_messages_say_something" CHECK ("feedback_messages"."body" is not null or "feedback_messages"."status_to" is not null)
);
--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_messages_idx" ON "feedback_messages" USING btree ("feedback_id","created_at");--> statement-breakpoint

ALTER TABLE "feedback" ADD COLUMN "submitter_read_at" timestamp with time zone;--> statement-breakpoint

-- A reply with nobody's name against it cannot become a message: the author is
-- required, and inventing one would put words in somebody's mouth. Every note
-- written through the console carries its handler, so this should never fire —
-- and if it does, losing the reply silently is the worse outcome by far.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "feedback"
		 WHERE "admin_note" IS NOT NULL
		   AND btrim("admin_note") <> ''
		   AND "handled_by_id" IS NULL
	) THEN
		RAISE EXCEPTION 'A feedback note has no recorded author, so it cannot be carried into the thread. Set handled_by_id on those rows first.';
	END IF;
END $$;--> statement-breakpoint

INSERT INTO "feedback_messages" ("id", "feedback_id", "author_id", "body", "created_at")
SELECT 'fbm_' || substr(md5("id"), 1, 12), "id", "handled_by_id", btrim("admin_note"),
       COALESCE("handled_at", "updated_at")
  FROM "feedback"
 WHERE "admin_note" IS NOT NULL
   AND btrim("admin_note") <> ''
   AND "handled_by_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "feedback" DROP COLUMN "admin_note";
