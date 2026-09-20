-- A PRICE LIST IS THE WHOLE COMPANY'S, not the field app's.
--
-- Mahek issues one list per region, per freight term and per negotiated
-- account — "MP & CG", "Odisha To Pay", "Odisha Paid", "S M Distributor" and
-- a few dozen more — each a PDF grid of products down and pack sizes across,
-- a GST-inclusive price per can in every cell. `mbos_price_list` was keyed on
-- a party-sheet tag, held zero rows, and could say nothing about who a list
-- applied to, what freight term it carried, or where a rate came from. It
-- stays until the handset reads from here; nothing below touches it.
--
-- What the four sample lists established, and what the shape follows from:
--   * the order sheet's Rate is ex-GST and the PDF is inclusive — times 1.18
--     lands on the PDF to the rupee — so rates are STORED ex-GST;
--   * "Paid" is "To Pay" plus twelve rupees a litre on every product, so a
--     list may be DERIVED from a parent by a rule rather than typed;
--   * which list applies is a hierarchy, narrowest wins, then freight term;
--   * a document is parsed into STAGING and published by a person.

-- ─────────────────────────────────────────────────────── the file itself
CREATE TABLE IF NOT EXISTS "price_list_documents" (
  "id" text PRIMARY KEY NOT NULL,
  "attachment_id" text REFERENCES "attachments"("id"),
  "file_hash" text NOT NULL,
  "filename" text NOT NULL,
  -- pdf_text | pdf_scan | image — decided from the bytes, never the name.
  "source_kind" text NOT NULL DEFAULT 'pdf_text',
  "byte_size" integer,
  "page_count" integer,
  "filename_hints" jsonb,
  -- queued → extracting → classifying → normalising → matching → validating →
  -- parsed | needs_review → published | rejected; failed from anywhere.
  "parse_status" text NOT NULL DEFAULT 'queued',
  "stage_started_at" timestamp with time zone,
  "stage_note" text,
  "parser_version" integer,
  "model_used" text,
  "layout" text,
  "confidence" integer,
  "extracted_text" text,
  "header" jsonb,
  "problems" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Text rather than a key: the two tables point at each other.
  "price_list_id" text,
  "uploaded_by_id" text REFERENCES "users"("id"),
  "parsed_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "published_by_id" text REFERENCES "users"("id"),
  "rejected_at" timestamp with time zone,
  "rejected_by_id" text REFERENCES "users"("id"),
  "reject_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_list_documents_hash_key" ON "price_list_documents" ("file_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_documents_status_idx" ON "price_list_documents" ("parse_status", "created_at");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────── the list
CREATE TABLE IF NOT EXISTS "price_lists" (
  "id" text PRIMARY KEY NOT NULL,
  "ref_no" text,
  "name" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "supersedes_id" text REFERENCES "price_lists"("id"),
  "document_id" text REFERENCES "price_list_documents"("id"),
  "effective_from" date NOT NULL,
  "effective_to" date,
  "validity_days" integer,
  -- inclusive | exclusive — what the DOCUMENT printed. Rates are stored ex-GST.
  "tax_basis" text NOT NULL DEFAULT 'inclusive',
  "gst_bp" integer NOT NULL DEFAULT 1800,
  "delivery_basis" text,
  -- to_pay | paid | not_stated
  "freight_term" text NOT NULL DEFAULT 'not_stated',
  "freight_per_litre_paise" bigint,
  "parent_list_id" text REFERENCES "price_lists"("id"),
  "derivation" jsonb,
  "unit_basis" text NOT NULL DEFAULT 'per_can',
  -- draft | published | superseded | withdrawn
  "status" text NOT NULL DEFAULT 'draft',
  "terms_text" text,
  "signatory" text,
  "notes" text,
  "published_at" timestamp with time zone,
  "published_by_id" text REFERENCES "users"("id"),
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by_id" text REFERENCES "users"("id"),
  "withdraw_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_lists_status_idx" ON "price_lists" ("status", "effective_from");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_lists_supersedes_idx" ON "price_lists" ("supersedes_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_lists_parent_idx" ON "price_lists" ("parent_list_id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────── the rates
CREATE TABLE IF NOT EXISTS "price_list_rates" (
  "id" text PRIMARY KEY NOT NULL,
  "price_list_id" text NOT NULL REFERENCES "price_lists"("id") ON DELETE CASCADE,
  "product_id" text NOT NULL REFERENCES "products"("id"),
  "rate_ex_gst_paise" bigint NOT NULL,
  "rate_incl_gst_paise" bigint NOT NULL,
  "min_cans" integer,
  "max_cans" integer,
  "offered" boolean NOT NULL DEFAULT true,
  "raw_product_text" text,
  "raw_pack_text" text,
  "raw_price_text" text,
  "source_ref" jsonb,
  "match_status" text NOT NULL DEFAULT 'manual',
  "match_confidence" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
-- One rate per list per SKU per slab. A flat price is the slab starting at
-- nothing, which is what coalesce says, so two flat prices for one SKU on one
-- list cannot both exist.
CREATE UNIQUE INDEX IF NOT EXISTS "price_list_rates_slab_key" ON "price_list_rates" ("price_list_id", "product_id", (coalesce("min_cans", 0)));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_rates_product_idx" ON "price_list_rates" ("product_id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────── who it applies to
CREATE TABLE IF NOT EXISTS "price_list_scopes" (
  "id" text PRIMARY KEY NOT NULL,
  "price_list_id" text NOT NULL REFERENCES "price_lists"("id") ON DELETE CASCADE,
  -- everybody | state | district | city | area | beat | customer_type | salesman | customer
  "scope_kind" text NOT NULL,
  "scope_value" text NOT NULL DEFAULT '',
  "scope_label" text,
  "parent_key" text NOT NULL DEFAULT '',
  -- any | to_pay | paid
  "freight_term_match" text NOT NULL DEFAULT 'any',
  "priority" integer NOT NULL DEFAULT 0,
  "valid_from" date,
  "valid_to" date,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by_id" text REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_scopes_list_idx" ON "price_list_scopes" ("price_list_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_scopes_lookup_idx" ON "price_list_scopes" ("scope_kind", "scope_value");
--> statement-breakpoint

-- ─────────────────────────────────────────── the discount sentences it prints
CREATE TABLE IF NOT EXISTS "price_list_discount_terms" (
  "id" text PRIMARY KEY NOT NULL,
  "price_list_id" text NOT NULL REFERENCES "price_lists"("id") ON DELETE CASCADE,
  -- advance_payment | quantity | prompt_payment | other
  "kind" text NOT NULL,
  "percent_bp" integer NOT NULL,
  "threshold_litres" integer,
  "threshold_paise" bigint,
  "raw_text" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_discount_terms_list_idx" ON "price_list_discount_terms" ("price_list_id");
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────── staging
CREATE TABLE IF NOT EXISTS "price_list_parse_rows" (
  "id" text PRIMARY KEY NOT NULL,
  "document_id" text NOT NULL REFERENCES "price_list_documents"("id") ON DELETE CASCADE,
  "page" integer NOT NULL DEFAULT 1,
  "row_index" integer NOT NULL,
  "col_index" integer NOT NULL,
  "raw_product_text" text NOT NULL,
  "raw_pack_text" text,
  "raw_price_text" text,
  "millilitres" integer,
  "cans_per_box" integer,
  "container" text,
  "rate_incl_gst_paise" bigint,
  "rate_ex_gst_paise" bigint,
  "offered" boolean NOT NULL DEFAULT true,
  "matched_product_id" text REFERENCES "products"("id") ON DELETE SET NULL,
  -- matched | alias | suggested | held | skipped | manual
  "match_status" text NOT NULL DEFAULT 'held',
  "match_confidence" integer,
  "candidates" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "problem" text,
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_parse_rows_document_idx" ON "price_list_parse_rows" ("document_id", "row_index", "col_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_list_parse_rows_status_idx" ON "price_list_parse_rows" ("document_id", "match_status");
--> statement-breakpoint

-- ──────────────────────────────────────────────── a special price, asked for
CREATE TABLE IF NOT EXISTS "price_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "customer_id" text NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "product_id" text NOT NULL REFERENCES "products"("id"),
  "requested_rate_ex_gst_paise" bigint NOT NULL,
  "current_rate_ex_gst_paise" bigint,
  "current_list_id" text,
  "reason" text NOT NULL,
  -- pending | approved | refused | withdrawn
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by_id" text NOT NULL REFERENCES "users"("id"),
  "decided_by_id" text REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "decision_note" text,
  "resulting_list_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_requests_status_idx" ON "price_requests" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_requests_customer_idx" ON "price_requests" ("customer_id");
--> statement-breakpoint

-- ──────────────────────────────────────────── what a list needs on the book
-- Who pays the freight, mirrored from the party sheet's "Payment type". It is
-- the second half of which list applies: "Odisha Paid" and "Odisha To Pay"
-- are one region and two answers to this question.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "freight_term" text,
  ADD COLUMN IF NOT EXISTS "delivery_type" text;
--> statement-breakpoint
-- Backfilled from the party rows already staged, on the same name match the
-- projection uses for the price tag. The projection keeps it current from here.
UPDATE "customers" c
   SET "freight_term" = CASE lower(trim(p."payment_type"))
                          WHEN 'paid' THEN 'paid'
                          WHEN 'to pay' THEN 'to_pay'
                          ELSE NULL END,
       "delivery_type" = nullif(trim(p."delivery_type"), '')
  FROM "sheet_party_rows" p
 WHERE p."status" = 'present'
   AND lower(trim(p."party_name")) = lower(trim(c."name"))
   AND c."freight_term" IS NULL;
--> statement-breakpoint

-- What the list said a line was worth on the day, written once at capture.
ALTER TABLE "interaction_product_lines"
  ADD COLUMN IF NOT EXISTS "list_rate_ex_gst_paise" bigint,
  ADD COLUMN IF NOT EXISTS "discount_bp" integer,
  ADD COLUMN IF NOT EXISTS "discount_authorised_by_id" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "price_list_id" text;
--> statement-breakpoint

-- The uploaded document is an attachment parent of its own. Added here and
-- USED by nothing in this migration: a value added to an enum may not be used
-- in the transaction that adds it, and drizzle-kit applies every pending
-- migration in one.
ALTER TYPE "attachment_parent" ADD VALUE IF NOT EXISTS 'price_list_document';
