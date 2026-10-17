-- WHERE A SALESMAN WORKS, AND WHAT HE SAID ABOUT IT. The office allocates his
-- cities and areas (mbos_user_territories); this is his half of that
-- conversation, written from the handset's Journeys screen. `accept` says he
-- has seen the allocation and takes it; `change` asks for different cities and
-- is decided on the Approvals queue like a tour (type 'territory').
--
-- `signature` is the allocation as it stood when he answered, so an
-- acceptance stops counting the moment somebody changes his areas.
-- `current_places` keeps the same allocation in words for whoever reads the
-- request later, after the allocation has moved on.
CREATE TABLE IF NOT EXISTS "mbos_territory_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_created_at" timestamp with time zone,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_id" text,
	"device_id" text,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"current_places" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_places" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"signature" text NOT NULL,
	CONSTRAINT "mbos_territory_requests_kind_check" CHECK ("kind" IN ('accept', 'change'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mbos_territory_requests_user_idx"
  ON "mbos_territory_requests" ("user_id", "server_created_at");
--> statement-breakpoint
-- The approval type a change request travels under. Added and NOT used here:
-- a value added to an enum cannot be used in the transaction that adds it,
-- and drizzle-kit runs every pending migration in one.
ALTER TYPE "mbos_approval_type" ADD VALUE IF NOT EXISTS 'territory';
