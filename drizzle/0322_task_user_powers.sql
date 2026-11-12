-- Tasks permissions granted to a person on Admin Console -> Access, under
-- Tasks: see everyone's tasks, give tasks to anyone, manage anyone's tasks,
-- run the automatic tasks. A Tasks administrator holds them all without a
-- row. See lib/tasks/permissions.ts.
CREATE TABLE IF NOT EXISTS "task_user_powers" (
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"power" text NOT NULL,
	"granted_by_id" text REFERENCES "users"("id"),
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_user_powers_pk" PRIMARY KEY ("user_id","power")
);
