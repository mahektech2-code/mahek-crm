-- PRODUCTION & DISPATCH TRACEABILITY (0237) — ADDITIVE ONLY.
--
-- SFG lot → refill (FG) lot → box → dispatch → customer, and back. The lots
-- already existed and already chain to each other; what this adds is:
--
--   * erp_sfg_qc — the QC verdict on an SFG lot. A lot with no row is
--     Pending, and only an Approved lot can be filled. Every lot already in
--     the book is written Approved, or filling would stop on deploy day.
--   * erp_units — one row per PHYSICAL box (or labelled loose can / drum),
--     with its own id (BX-YYMMDD-NNNNNN), the lot it came from and where it
--     stands. Boxes are minted when a packing batch completes.
--   * erp_unit_events — every change of a unit, appended and never edited:
--     the unit's history is the audit trail.
--   * erp_dispatch_scans — every scan at dispatch, refused ones included, so
--     a duplicate or mismatched scan is counted rather than lost.
--   * erp_dispatch_overrides — a mismatched scan asked to go anyway, with the
--     reason, who asked and who decided.

CREATE TABLE IF NOT EXISTS "erp_sfg_qc" (
  "lot_code" text PRIMARY KEY NOT NULL,
  "status" text NOT NULL DEFAULT 'Pending',
  "note" text,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_sfg_qc_status_check" CHECK ("status" in ('Pending', 'Approved', 'Rejected'))
);
--> statement-breakpoint
INSERT INTO "erp_sfg_qc" ("lot_code", "status", "note", "decided_at")
SELECT DISTINCT "lot_code", 'Approved', 'In stock before SFG QC was recorded', now() FROM "erp_sfg_lines"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_sfg_qc" ("lot_code", "status", "note", "decided_at")
SELECT DISTINCT "lot_code", 'Approved', 'In stock before SFG QC was recorded', now() FROM "erp_sfg_entries"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_units" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "sku_id" text NOT NULL REFERENCES "products"("id"),
  "lot_from" text NOT NULL,
  "lot_code" text NOT NULL,
  "finished_good_id" text REFERENCES "finished_goods"("id"),
  "seq" integer NOT NULL,
  "cans" integer NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "status" text NOT NULL DEFAULT 'available',
  "status_note" text,
  "order_id" text REFERENCES "erp_orders"("id"),
  "scanned_at" timestamp with time zone,
  "scanned_by_id" text REFERENCES "users"("id"),
  "dispatched_at" timestamp with time zone,
  "label_printed_at" timestamp with time zone,
  "label_prints" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_units_kind_check" CHECK ("kind" in ('box', 'loose')),
  CONSTRAINT "erp_units_status_check" CHECK ("status" in ('available', 'scanned', 'dispatched', 'hold', 'rejected', 'returned', 'lost', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_units_lot_idx" ON "erp_units" ("lot_from", "lot_code", "godown_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_units_order_idx" ON "erp_units" ("order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_units_status_idx" ON "erp_units" ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_units_seq_key" ON "erp_units" ("lot_from", "lot_code", "seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_unit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "erp_units"("id"),
  "event" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "order_id" text,
  "godown_id" text,
  "note" text,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_unit_events_unit_idx" ON "erp_unit_events" ("unit_id", "at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_dispatch_scans" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "order_no" integer,
  "result" text NOT NULL,
  "message" text NOT NULL,
  "unit_id" text,
  "order_id" text,
  "by_id" text REFERENCES "users"("id"),
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_dispatch_scans_at_idx" ON "erp_dispatch_scans" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erp_dispatch_scans_order_idx" ON "erp_dispatch_scans" ("order_no", "at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "erp_dispatch_overrides" (
  "id" text PRIMARY KEY NOT NULL,
  "unit_id" text NOT NULL REFERENCES "erp_units"("id"),
  "order_id" text NOT NULL REFERENCES "erp_orders"("id"),
  "ordered_sku_id" text NOT NULL REFERENCES "products"("id"),
  "scanned_sku_id" text NOT NULL REFERENCES "products"("id"),
  "mismatch" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'Pending',
  "requested_by_id" text REFERENCES "users"("id"),
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "used_at" timestamp with time zone,
  CONSTRAINT "erp_dispatch_overrides_status_check" CHECK ("status" in ('Pending', 'Approved', 'Declined', 'Used'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "erp_dispatch_overrides_open_key" ON "erp_dispatch_overrides" ("unit_id", "order_id") WHERE "status" in ('Pending', 'Approved');
--> statement-breakpoint
INSERT INTO "erp_series" ("key", "last") VALUES ('unit', 0) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- The three new screens reach whoever already works the screens they serve.
-- An account with no ERP module rows holds every screen already and is not
-- touched; a designation holding `all_screens` likewise. Rows are added to the
-- designation AND to its holders together, so nobody turns "customised".
INSERT INTO "app_module_access" ("id", "user_id", "app", "module", "granted_by_id")
SELECT DISTINCT ON (m."user_id", n."module")
       'mod_' || substr(md5(m."user_id" || '|' || n."module"), 1, 16),
       m."user_id", m."app", n."module", m."granted_by_id"
  FROM "app_module_access" m
  JOIN (VALUES ('erp.orders', 'erp.dispatch'), ('erp.orders', 'erp.units'), ('erp.orders', 'erp.trace'),
               ('erp.packBatches', 'erp.units'), ('erp.packBatches', 'erp.trace'),
               ('erp.sfgBatches', 'erp.trace'), ('erp.fgFill', 'erp.trace')) AS n("from", "module") ON n."from" = m."module"
 ORDER BY m."user_id", n."module"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "erp_designation_modules" ("designation_id", "module")
SELECT DISTINCT d."designation_id", n."module"
  FROM "erp_designation_modules" d
  JOIN (VALUES ('erp.orders', 'erp.dispatch'), ('erp.orders', 'erp.units'), ('erp.orders', 'erp.trace'),
               ('erp.packBatches', 'erp.units'), ('erp.packBatches', 'erp.trace'),
               ('erp.sfgBatches', 'erp.trace'), ('erp.fgFill', 'erp.trace')) AS n("from", "module") ON n."from" = d."module"
ON CONFLICT DO NOTHING;
