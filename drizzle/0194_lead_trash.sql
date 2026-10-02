-- THE LEAD TRASH. Deleting a lead moves it here rather than removing it: the
-- row stays, with everything that points at it — calls, reminders, notes,
-- visits, WhatsApp — so restoring it brings back the whole lead exactly as it
-- was, and a lead deleted by mistake is a click away rather than gone.
--
-- `deleted_at` set means "in the trash". Every screen that lists, counts,
-- searches, queues, messages or syncs a lead leaves those rows out. Only a
-- LEAD can be trashed: an account we have invoiced is history the ledger
-- needs, and is deactivated rather than deleted.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_by_id text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_by_name text;
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_reason text;
--> statement-breakpoint
-- The trash list reads newest-deleted first; the partial index holds only the
-- handful of trashed rows, so it costs the live book nothing.
CREATE INDEX IF NOT EXISTS customers_deleted_at_idx ON customers (deleted_at DESC) WHERE deleted_at IS NOT NULL;
--> statement-breakpoint
-- Every move in and out, kept: who deleted it and why, who brought it back.
-- The columns above are the CURRENT state; this is the history.
CREATE TABLE IF NOT EXISTS lead_trash_events (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('trashed', 'restored')),
  reason text,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  actor_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lead_trash_events_customer_idx ON lead_trash_events (customer_id, created_at DESC);
