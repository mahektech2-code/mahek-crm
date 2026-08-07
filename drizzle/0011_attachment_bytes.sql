-- §4 — attachment bytes, when Postgres is the backend.
--
-- Its own table, never a column on `attachments`: a listing reads filenames
-- and sizes constantly, and with the bytes alongside them every such read
-- would drag megabytes through the connection pool to display a name.
--
-- Rows here are storage, not record. Deleting one destroys no history — the
-- `attachments` row survives with status 'removed', which is what the rule
-- about never destroying a customer interaction actually protects.
CREATE TABLE IF NOT EXISTS "attachment_bytes" (
  "ref" text PRIMARY KEY NOT NULL,
  "bytes" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
