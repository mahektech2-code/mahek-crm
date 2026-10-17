-- ERP phase 5: transport follow-up, customer requests and credit notes, order
-- follow-up, petty cash and help videos (spec §12–§13).

-- One per bill (order number), written when its first detail line is
-- dispatch-verified (spec §18). The copied columns are what the bill said on
-- that day; LR, stage and reminder are the logistics desk's own.
CREATE TABLE IF NOT EXISTS "erp_transports" (
  "id" text PRIMARY KEY NOT NULL,
  "order_no" integer NOT NULL,
  "bill_date" date,
  "billing_customer_id" text NOT NULL REFERENCES "customers"("id"),
  "bill_no" text,
  "lr_no" text,
  "transporter" text,
  "area" text,
  "note" text,
  "payment_type" text,
  "extra_expense_paise" bigint,
  "track_status" text DEFAULT 'Don''t Track' NOT NULL,
  "material_stage" text DEFAULT 'Dispatch from Bhiwandi' NOT NULL,
  "reminder_date" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_transports_track_check" CHECK ("track_status" in ('Track', 'Don''t Track')),
  CONSTRAINT "erp_transports_stage_check" CHECK ("material_stage" in ('Dispatch from Bhiwandi', 'Dispatch from Ambernath', 'In Transit', 'On the way to Destination area', 'Reached Destination Area', 'Close - Received to Party'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "erp_transports_order_key" ON "erp_transports" ("order_no");

CREATE TABLE IF NOT EXISTS "erp_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "raised_at" timestamp with time zone DEFAULT now() NOT NULL,
  "salesman_name" text,
  "customer_id" text NOT NULL REFERENCES "customers"("id"),
  "mobile" text,
  "complaint_type" text,
  "description" text,
  "photo_id" text,
  "cn_required" boolean DEFAULT false NOT NULL,
  "bill_no" text,
  "bill_date" date,
  "goods" text,
  "status" text DEFAULT 'Requested' NOT NULL,
  "cn_amount_paise" bigint,
  "cn_date" date,
  "cn_number" text,
  "remark" text,
  "cn_file_id" text,
  "responsible" text,
  "approved_at" timestamp with time zone,
  "approved_by_id" text REFERENCES "users"("id"),
  "resolved_at" timestamp with time zone,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_requests_status_check" CHECK ("status" in ('Requested', 'Accepted', 'Rejected'))
);
CREATE INDEX IF NOT EXISTS "erp_requests_customer_idx" ON "erp_requests" ("customer_id");

-- One per order-details line (RowKey = Order ID). Everything else it shows is
-- derived from the orders themselves.
CREATE TABLE IF NOT EXISTS "erp_followups" (
  "order_id" text PRIMARY KEY NOT NULL REFERENCES "erp_orders"("id"),
  "reminder_days_party" integer,
  "reminder_days_product" integer,
  "remark" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_id" text REFERENCES "users"("id")
);

CREATE TABLE IF NOT EXISTS "erp_credits" (
  "id" text PRIMARY KEY NOT NULL,
  "credit_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "employee_name" text NOT NULL,
  "mode" text NOT NULL,
  "amount_paise" bigint NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_credits_mode_check" CHECK ("mode" in ('Bank Cash', 'Cash', 'Other')),
  CONSTRAINT "erp_credits_amount_check" CHECK ("amount_paise" > 0)
);

CREATE TABLE IF NOT EXISTS "erp_expenses" (
  "id" text PRIMARY KEY NOT NULL,
  "expense_date" date NOT NULL,
  "godown_id" text NOT NULL REFERENCES "erp_godowns"("id"),
  "expense_by" text NOT NULL,
  "category" text,
  "mode" text NOT NULL,
  "particular" text,
  "amount_paise" bigint NOT NULL,
  "note" text,
  "status" text DEFAULT 'Pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  "updated_by_id" text,
  CONSTRAINT "erp_expenses_mode_check" CHECK ("mode" in ('Bank Cash', 'Cash', 'Other')),
  CONSTRAINT "erp_expenses_status_check" CHECK ("status" in ('Verify', 'Pending')),
  CONSTRAINT "erp_expenses_amount_check" CHECK ("amount_paise" > 0)
);

CREATE TABLE IF NOT EXISTS "erp_videos" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "source" text NOT NULL,
  "file_id" text,
  "youtube_url" text,
  "tags" text[] DEFAULT '{}' NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_id" text REFERENCES "users"("id"),
  CONSTRAINT "erp_videos_source_check" CHECK ("source" in ('youtube', 'file'))
);

INSERT INTO "erp_ref_values" ("id", "list_key", "value", "sort_order") VALUES
  ('erprv_exp_cat_transport', 'expenseCategory', 'Transport', 1),
  ('erprv_exp_cat_office', 'expenseCategory', 'Office', 2),
  ('erprv_exp_cat_labour', 'expenseCategory', 'Labour', 3),
  ('erprv_exp_part_tea', 'expenseParticular', 'Tea and snacks', 1),
  ('erprv_exp_part_fuel', 'expenseParticular', 'Fuel', 2),
  ('erprv_exp_part_courier', 'expenseParticular', 'Courier', 3),
  ('erprv_credit_note_advance', 'creditNote', 'Advance', 1),
  ('erprv_video_tag_orders', 'videoTag', 'Orders', 1),
  ('erprv_video_tag_stock', 'videoTag', 'Stock', 2)
ON CONFLICT DO NOTHING;
